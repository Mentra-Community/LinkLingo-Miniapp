/**
 * Durable delivery of learning events from LinkLingo phones to the Mandarin
 * backend. The phone queue is the first stage; this is the second:
 *
 *   phone queue --(ack after S3 write)--> S3 outbox --(delete after Mandarin commit)--> Mandarin
 *
 * Neither end is acknowledged until the next stage has durably stored the
 * event, so a restart or a lost reply at any boundary replays the same
 * eventId and Mandarin dedupes it. This outbox is separate from the 24 hour
 * tape and is never pruned by it.
 */

import {createCipheriv, createDecipheriv, createHash, randomBytes} from "node:crypto"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {ObjectStore} from "./tape-store"
import {
  MandarinVocabularyBatchResponseSchema,
  type MandarinVocabularyBatchRequest,
  type VocabularyBatch,
} from "./vocabulary-contract"
import {
  IngestBatchResponseSchema,
  LEARNING_SCHEMA_VERSION,
  LearningEventSchema,
  MAX_BATCH_EVENTS,
  PairingRedeemResponseSchema,
  type LearningEvent,
  type SourceIdentity,
} from "../vendor/mandarin-contract"

const log = createLogger("learning")

export const RETRY_WINDOW_MS = 7 * 24 * 3_600_000
const BACKOFF_BASE_MS = 2_000
const BACKOFF_CAP_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 15_000

export interface LearningConfig {
  enabled: boolean
  /** Base URL of the Mandarin server, e.g. https://mandarin.example.com */
  mandarinUrl: string
  /** Shared service key for pairing redemption. */
  serviceKey: string
  /** 32 raw bytes, used to encrypt the delivery credential at rest. */
  configKey: Buffer | null
}

export function learningConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LearningConfig {
  const key = env.LINKLINGO_LEARNING_CONFIG_KEY?.trim()
  const decoded = key ? Buffer.from(key, "base64") : null
  return {
    enabled: env.LINKLINGO_LEARNING_ENABLED?.trim() === "true",
    mandarinUrl: (env.MANDARIN_LEARNING_URL ?? "").trim().replace(/\/+$/, ""),
    serviceKey: (env.MANDARIN_SERVICE_KEY ?? "").trim(),
    configKey: decoded && decoded.length === 32 ? decoded : null,
  }
}

/** Why learning is unavailable, so the phone shows an actionable state instead of a generic failure. */
export function configProblem(config: LearningConfig): string | null {
  if (!config.enabled) return "Learning capture is not enabled on this server."
  if (!config.mandarinUrl || config.serviceKey.length < 32) return "Learning is not configured on this server."
  if (!config.configKey) return "Learning storage key is missing on this server."
  return null
}

export function userKeyFor(identity: SourceIdentity): string {
  return createHash("sha256")
    .update(`${identity.issuer}|${identity.subject}|${identity.environment}`)
    .digest("hex")
    .slice(0, 40)
}

/** Same digest used by the transcript tape; kept separate from the delivery/account key. */
export function transcriptUserFor(identity: SourceIdentity): string {
  return createHash("sha256").update(identity.subject).digest("hex").slice(0, 8)
}

// ----------------------------------------------------------- Encryption

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
}

export function decryptSecret(key: Buffer, encoded: string): string {
  const raw = Buffer.from(encoded, "base64")
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8")
}

// --------------------------------------------------------------- Types

interface StoredConnection {
  v: 1
  userKey: string
  /** Matches TranscriptEntry.user without retaining the raw Mentra subject. */
  transcriptUser?: string
  connectionId: string
  label: string
  environment: string
  /** AES-GCM, base64. Never logged. */
  credential: string
  createdAt: string
  lastAcceptedAt: string | null
  revokedAt: string | null
}

export interface LearningStatus {
  enabled: boolean
  problem: string | null
  connected: boolean
  label: string | null
  environment: string | null
  lastAcceptedAt: string | null
  /** Events stored here and not yet committed by Mandarin. */
  pendingServerEvents: number
  lastError: string | null
}

export interface DrainResult {
  delivered: number
  quarantined: number
  expired: number
  remaining: number
  outcome: "idle" | "delivered" | "retry_later" | "needs_attention" | "revoked" | "not_connected"
}

export class PairError extends Error {
  constructor(
    readonly kind: "invalid" | "unavailable" | "not_configured",
    message: string,
  ) {
    super(message)
  }
}

export interface LearningDeps {
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
}

const pad = (n: number, width: number) => String(Math.max(0, Math.trunc(n))).padStart(width, "0")

function outboxPrefix(userKey: string): string {
  return `learning/outbox/${userKey}/`
}

function outboxKey(userKey: string, event: LearningEvent): string {
  const at = Date.parse(event.capturedAt)
  const safe = event.eventId.replace(/[^A-Za-z0-9_-]/g, "_")
  return `${outboxPrefix(userKey)}${pad(at, 16)}-${pad(event.sequence, 9)}-${safe}.json`
}

const connectionKey = (userKey: string) => `learning/connections/${userKey}.json`

function mandarinVocabularyRequest(batch: VocabularyBatch): MandarinVocabularyBatchRequest {
  return {
    schemaVersion: batch.schemaVersion,
    batchId: batch.batchId,
    sourceDay: batch.localDate,
    candidates: batch.candidates.map((candidate) => ({
      word: candidate.word,
      pinyin: candidate.pinyin,
      meaning: candidate.english,
      situation: `Link Lingo on ${batch.localDate} across ${candidate.distinctSessions} inferred ${
        candidate.distinctSessions === 1 ? "session" : "sessions"
      }.`,
      count: candidate.totalAppearances,
      sessionIds: [...new Set(candidate.contexts.map((context) => context.sessionId))],
      contexts: [...new Set(candidate.contexts.map((context) => context.text))],
      rank: candidate.corpusRank,
      reasons: candidate.reasons,
    })),
  }
}

export class LearningService {
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly random: () => number
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly failures = new Map<string, {count: number; nextAt: number; error: string | null}>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly store: ObjectStore,
    readonly config: LearningConfig,
    deps: LearningDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch
    this.now = deps.now ?? (() => Date.now())
    this.random = deps.random ?? Math.random
  }

  // ---------------------------------------------------------- connection

  private async loadConnection(userKey: string): Promise<StoredConnection | null> {
    const raw = await this.store.get(connectionKey(userKey))
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredConnection
    } catch (error) {
      log.error("connection record unreadable", {userKey, error})
      return null
    }
  }

  private async saveConnection(connection: StoredConnection): Promise<void> {
    await this.store.put(connectionKey(connection.userKey), JSON.stringify(connection))
  }

  private credentialOf(connection: StoredConnection): string {
    if (!this.config.configKey) throw new Error("learning config key missing")
    return decryptSecret(this.config.configKey, connection.credential)
  }

  /** Redeems the pairing secret with Mandarin under the verified Mentra identity and stores the delivery credential encrypted. */
  async pair(identity: SourceIdentity, secret: string): Promise<{label: string; environment: string}> {
    const problem = configProblem(this.config)
    if (problem) throw new PairError("not_configured", problem)
    const userKey = userKeyFor(identity)
    let response: Response
    try {
      response = await this.fetchImpl(`${this.config.mandarinUrl}/v1/learning/pairing/redeem`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": `Bearer ${this.config.serviceKey}`},
        body: JSON.stringify({secret: secret.trim(), source: identity, label: `LinkLingo (${identity.environment})`}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      log.warn("pairing request failed", {error: String(error)})
      throw new PairError("unavailable", "Could not reach the Mandarin server. Try again.")
    }
    if (response.status === 410 || response.status === 400) {
      throw new PairError(
        "invalid",
        "This pairing code is invalid, expired, or already used. Create a new one in the Mandarin app.",
      )
    }
    if (!response.ok) throw new PairError("unavailable", `The Mandarin server answered ${response.status}. Try again.`)
    const parsed = PairingRedeemResponseSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new PairError("unavailable", "The Mandarin server sent an unexpected reply.")

    // Re-pairing replaces the old connection; its queued events belong to a revoked connection.
    await this.purgeOutbox(userKey)
    await this.saveConnection({
      v: 1,
      userKey,
      transcriptUser: transcriptUserFor(identity),
      connectionId: parsed.data.connectionId,
      label: identity.environment === "prod" ? "Mandarin" : `Mandarin (${identity.environment})`,
      environment: identity.environment,
      credential: encryptSecret(this.config.configKey!, parsed.data.deliveryCredential),
      createdAt: new Date(this.now()).toISOString(),
      lastAcceptedAt: null,
      revokedAt: null,
    })
    this.failures.delete(userKey)
    metrics.increment("learning_pairings_total", {outcome: "ok"})
    return {label: parsed.data.ownerLabel || "Mandarin", environment: identity.environment}
  }

  /** Forgets the credential and purges queued transport data. Imported history stays in Mandarin. */
  async revoke(userKey: string): Promise<void> {
    const connection = await this.loadConnection(userKey)
    if (connection && !connection.revokedAt) {
      await this.saveConnection({...connection, revokedAt: new Date(this.now()).toISOString()})
    }
    await this.purgeOutbox(userKey)
    this.failures.delete(userKey)
  }

  private async purgeOutbox(userKey: string): Promise<void> {
    const keys = await this.store.list(outboxPrefix(userKey))
    if (keys.length) await this.store.delete(keys)
  }

  async pendingCount(userKey: string): Promise<number> {
    return (await this.store.list(outboxPrefix(userKey))).length
  }

  async status(identity: SourceIdentity): Promise<LearningStatus> {
    const userKey = userKeyFor(identity)
    const problem = configProblem(this.config)
    let connection = problem ? null : await this.loadConnection(userKey)
    // Connections created before daily vocabulary scanning did not retain this
    // digest. Any authenticated status/events request repairs them in place.
    if (connection && !connection.transcriptUser) {
      connection = {...connection, transcriptUser: transcriptUserFor(identity)}
      await this.saveConnection(connection)
    }
    const active = connection && !connection.revokedAt ? connection : null
    return {
      enabled: problem === null,
      problem,
      connected: Boolean(active),
      label: active?.label ?? null,
      environment: active?.environment ?? null,
      lastAcceptedAt: active?.lastAcceptedAt ?? null,
      pendingServerEvents: active ? await this.pendingCount(userKey) : 0,
      lastError: this.failures.get(userKey)?.error ?? null,
    }
  }

  // -------------------------------------------------------------- intake

  /**
   * Stores events durably. The caller acknowledges the phone only after this
   * resolves; if any write fails the whole batch is retried and the events
   * that did land are simply overwritten with identical content.
   */
  async enqueue(
    userKey: string,
    rawEvents: unknown[],
  ): Promise<{accepted: string[]; rejected: Array<{eventId: string; reason: string}>}> {
    const accepted: string[] = []
    const rejected: Array<{eventId: string; reason: string; permanent: true}> = []
    const writes: Array<Promise<void>> = []
    for (const raw of rawEvents.slice(0, MAX_BATCH_EVENTS)) {
      const parsed = LearningEventSchema.safeParse(raw)
      if (!parsed.success) {
        const id = (raw as {eventId?: unknown})?.eventId
        rejected.push({
          eventId: typeof id === "string" ? id : "unknown",
          reason: parsed.error.issues[0]?.message ?? "malformed event",
          permanent: true,
        })
        continue
      }
      const event = parsed.data
      const key = outboxKey(userKey, event)
      writes.push(this.store.put(key, JSON.stringify(event)))
      accepted.push(event.eventId)
    }
    await Promise.all(writes)
    metrics.increment("learning_events_total", {outcome: "stored"}, accepted.length)
    if (rejected.length) metrics.increment("learning_events_total", {outcome: "rejected"}, rejected.length)
    return {accepted, rejected}
  }

  // ------------------------------------------------------------ delivery

  /** Delivers queued events for one user. Serialized per user so triggers never overlap. */
  drain(userKey: string): Promise<DrainResult> {
    const previous = this.locks.get(userKey) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.drainOnce(userKey))
    this.locks.set(userKey, run)
    void run
      .finally(() => {
        if (this.locks.get(userKey) === run) this.locks.delete(userKey)
      })
      .catch(() => undefined)
    return run
  }

  private backoff(userKey: string, error: string): void {
    const prior = this.failures.get(userKey)?.count ?? 0
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** prior) * (0.5 + this.random())
    this.failures.set(userKey, {count: prior + 1, nextAt: this.now() + delay, error})
  }

  private async drainOnce(userKey: string): Promise<DrainResult> {
    const result: DrainResult = {delivered: 0, quarantined: 0, expired: 0, remaining: 0, outcome: "idle"}
    const connection = await this.loadConnection(userKey)
    if (!connection || connection.revokedAt) return {...result, outcome: "not_connected"}
    const failure = this.failures.get(userKey)
    if (failure && failure.nextAt > this.now())
      return {...result, outcome: "retry_later", remaining: await this.pendingCount(userKey)}

    for (let round = 0; round < 20; round++) {
      const keys = (await this.store.list(outboxPrefix(userKey))).sort()
      if (!keys.length) break
      const batchKeys = keys.slice(0, MAX_BATCH_EVENTS)
      const live: Array<{key: string; event: LearningEvent}> = []

      for (const key of batchKeys) {
        const body = await this.store.get(key)
        const parsed = body ? LearningEventSchema.safeParse(safeJson(body)) : null
        if (!parsed?.success) {
          await this.quarantine(userKey, key, body, "unreadable event")
          result.quarantined++
          continue
        }
        if (this.now() - Date.parse(parsed.data.capturedAt) > RETRY_WINDOW_MS) {
          // Expired events become an explicit gap, never a silent loss.
          await this.recordGap(userKey, parsed.data)
          await this.store.delete([key])
          result.expired++
          continue
        }
        live.push({key, event: parsed.data})
      }
      if (!live.length) continue

      let response: Response
      try {
        response = await this.fetchImpl(`${this.config.mandarinUrl}/v1/learning/ingest`, {
          method: "POST",
          headers: {"Content-Type": "application/json", "Authorization": `Bearer ${this.credentialOf(connection)}`},
          body: JSON.stringify({schemaVersion: LEARNING_SCHEMA_VERSION, events: live.map((item) => item.event)}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        this.backoff(userKey, "Mandarin is unreachable")
        log.warn("delivery failed", {userKey, error: String(error)})
        return {...result, outcome: "retry_later", remaining: await this.pendingCount(userKey)}
      }

      if (response.status === 403) {
        // Revoked on the Mandarin side: stop, purge, and surface it.
        await this.revoke(userKey)
        this.failures.set(userKey, {
          count: 0,
          nextAt: 0,
          error: "The Mandarin connection was revoked. Pair again to resume.",
        })
        return {...result, outcome: "revoked"}
      }
      if (response.status === 401) {
        this.backoff(userKey, "Mandarin rejected the saved credential. Pair again.")
        return {...result, outcome: "needs_attention", remaining: await this.pendingCount(userKey)}
      }
      if (!response.ok) {
        this.backoff(userKey, `Mandarin answered ${response.status}`)
        return {...result, outcome: "retry_later", remaining: await this.pendingCount(userKey)}
      }

      const parsed = IngestBatchResponseSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) {
        this.backoff(userKey, "Mandarin sent an unexpected reply")
        return {...result, outcome: "retry_later", remaining: await this.pendingCount(userKey)}
      }

      const outcomes = new Map(parsed.data.results.map((r) => [r.eventId, r]))
      const committed: string[] = []
      const dropped: string[] = []
      for (const {key, event} of live) {
        const outcome = outcomes.get(event.eventId)
        if (!outcome) continue
        if (outcome.outcome === "accepted" || outcome.outcome === "duplicate") {
          committed.push(key)
        } else if (outcome.outcome === "deleted") {
          // The learner deleted this source in Mandarin. Drop our copy; never keep it in quarantine.
          dropped.push(key)
        } else {
          await this.quarantine(userKey, key, JSON.stringify(event), `${outcome.outcome}: ${outcome.reason ?? ""}`)
          result.quarantined++
        }
      }
      // Delete only after Mandarin confirmed the commit (or confirmed the source was deleted).
      if (committed.length || dropped.length) await this.store.delete([...committed, ...dropped])
      if (dropped.length) metrics.increment("learning_events_total", {outcome: "dropped_deleted"}, dropped.length)
      result.delivered += committed.length
      if (committed.length) {
        metrics.increment("learning_events_total", {outcome: "delivered"}, committed.length)
        await this.saveConnection({...connection, lastAcceptedAt: new Date(this.now()).toISOString()})
        connection.lastAcceptedAt = new Date(this.now()).toISOString()
      }
      if (!committed.length && !dropped.length) break
    }
    this.failures.delete(userKey)
    result.remaining = await this.pendingCount(userKey)
    result.outcome = result.delivered > 0 ? "delivered" : "idle"
    return result
  }

  private async quarantine(userKey: string, key: string, body: string | null, reason: string): Promise<void> {
    const name = key.split("/").pop() ?? key
    await this.store.put(
      `learning/quarantine/${userKey}/${name}`,
      JSON.stringify({reason, at: new Date(this.now()).toISOString(), body: body ? (safeJson(body) ?? null) : null}),
    )
    await this.store.delete([key])
    metrics.increment("learning_events_total", {outcome: "quarantined"})
    log.warn("event quarantined", {userKey, reason})
  }

  private async recordGap(userKey: string, event: LearningEvent): Promise<void> {
    await this.store.put(
      `learning/gaps/${userKey}/${pad(this.now(), 16)}-${event.eventId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`,
      JSON.stringify({
        reason: "expired",
        sourceSessionId: event.sourceSessionId,
        sequence: event.sequence,
        capturedAt: event.capturedAt,
      }),
    )
    metrics.increment("learning_events_total", {outcome: "expired"})
  }

  /** Delivers for every connected user; used by the periodic timer. */
  async drainAll(): Promise<void> {
    const keys = await this.store.list("learning/connections/")
    for (const key of keys) {
      const userKey = key.slice("learning/connections/".length).replace(/\.json$/, "")
      await this.drain(userKey).catch((error) => log.warn("drain failed", {userKey, error: String(error)}))
    }
  }

  /**
   * Posts a durable vocabulary batch through the connection belonging to the
   * same transcript digest. Mandarin must dedupe by batchId.
   */
  async deliverVocabularyBatch(
    transcriptUser: string,
    batch: VocabularyBatch,
  ): Promise<{
    outcome: "accepted" | "duplicate" | "not_connected" | "retry_later" | "revoked" | "needs_attention"
    error?: string
  }> {
    const keys = await this.store.list("learning/connections/")
    let connection: StoredConnection | null = null
    for (const key of keys) {
      const body = await this.store.get(key)
      const candidate = body ? (safeJson(body) as StoredConnection | undefined) : undefined
      if (candidate?.transcriptUser === transcriptUser && !candidate.revokedAt) {
        connection = candidate
        break
      }
    }
    if (!connection) return {outcome: "not_connected"}

    let response: Response
    try {
      const request = mandarinVocabularyRequest(batch)
      response = await this.fetchImpl(`${this.config.mandarinUrl}/v1/learning/vocabulary/batches`, {
        method: "POST",
        headers: {"Content-Type": "application/json", "Authorization": `Bearer ${this.credentialOf(connection)}`},
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      log.warn("vocabulary delivery failed", {
        userKey: connection.userKey,
        batchId: batch.batchId,
        error: String(error),
      })
      return {outcome: "retry_later", error: "Mandarin is unreachable"}
    }

    if (response.status === 403) {
      await this.revoke(connection.userKey)
      return {outcome: "revoked", error: "The Mandarin connection was revoked."}
    }
    if (response.status === 401) {
      this.failures.set(connection.userKey, {
        count: 0,
        nextAt: 0,
        error: "Mandarin rejected the saved credential. Pair again.",
      })
      return {outcome: "needs_attention", error: "Mandarin rejected the saved credential. Pair again."}
    }
    if (!response.ok) return {outcome: "retry_later", error: `Mandarin answered ${response.status}`}

    const parsed = MandarinVocabularyBatchResponseSchema.safeParse(await response.json().catch(() => null))
    if (!parsed.success || parsed.data.batchId !== batch.batchId) {
      return {outcome: "retry_later", error: "Mandarin sent an unexpected vocabulary reply"}
    }
    return {outcome: "accepted"}
  }

  start(intervalMs = 5_000): void {
    if (this.timer || configProblem(this.config)) return
    this.timer = setInterval(() => void this.drainAll(), intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
