/**
 * Durable, phone-side capture of every final recognized transcript segment.
 *
 * The caption path hands each final to `enqueue`, which persists it to
 * `session.storage` before anything else happens. Delivery to the backend is a
 * separate, retried, at-least-once step (`drain`): an event leaves the queue
 * only after the backend names its id in `accepted` (ack-after-durable), and a
 * retry always resends the same `eventId`. Nothing here is ever awaited by the
 * caption path, and no model is involved.
 *
 * Runs in the bare background engine (see miniapp/AGENTS.md): only
 * `Date.now`, timers, `TextEncoder`, `crypto.*`, and `JSON`. The shared
 * contract is imported as a TYPE only so zod stays out of the phone bundle.
 *
 * ## Storage layout (session.storage, string KV backed by MMKV)
 *
 * The SDK documents `session.storage` as a "small string KV" and advises that
 * the namespace stay "typical < 1 MB" because `getAll()` can stall the JS
 * context; it declares no per-value or total quota. A 10 MB queue in one value
 * would be rewritten on every utterance, so the queue is sharded:
 *
 *   linklingo:learn:index      small JSON: chunk table [[id,count,bytes]...],
 *                              capture gaps, quarantine counters, last-accepted
 *                              time, last session/sequence, last known
 *                              connection. Pending count/bytes are DERIVED from
 *                              the chunk table, so they cannot drift.
 *   linklingo:learn:c:<id>     one chunk: {"v":1,"id":n,"events":[LearningEvent]}
 *                              (<= 32 KB and <= 50 events). Only the newest
 *                              (tail) chunk is appended to; older chunks are
 *                              immutable until acked or dropped.
 *   linklingo:learn:q:<n>      one quarantine record (corrupt chunk / corrupt
 *                              index / permanently rejected event). The newest
 *                              50 are kept; the total is counted in the index.
 *
 * Write ordering is chosen so a crash between two writes can only cause a
 * duplicate delivery (deduplicated by eventId on the server), never a loss:
 *   - add:      chunk first, then index. A chunk written but not indexed is
 *               adopted on the next load (probe at `nextChunkId`).
 *   - remove:   index first, then chunk. A stale chunk is reconciled on load.
 * All queue mutation runs through one promise-chain lock, and the network send
 * happens OUTSIDE the lock, so enqueue never waits on delivery.
 */

import type {LearningEvent} from "../shared/mandarin-contract"
import {createLogger, diagnostics} from "./observability"

const log = createLogger("learning")

/** Wire schema version of the transport contract (mirrors LEARNING_SCHEMA_VERSION; kept local so no runtime import is needed). */
export const LEARNING_SCHEMA_VERSION = 1 as const

export type CaptureMode = LearningEvent["mode"]
export type CaptureDisposition = LearningEvent["disposition"]

export const ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/

/** Longest recognized text the contract accepts for one segment (UTF-16 code units). */
export const MAX_EVENT_TEXT = 2000

const DEFAULTS = {
  maxBytes: 10 * 1024 * 1024,
  expiryMs: 7 * 24 * 60 * 60 * 1000,
  batchMaxEvents: 50,
  batchMaxBytes: 256 * 1024,
  chunkMaxBytes: 32 * 1024,
  chunkMaxEvents: 50,
  backoffBaseMs: 2_000,
  backoffMaxMs: 5 * 60_000,
  drainDebounceMs: 2_000,
  timezone: "Asia/Shanghai",
  /** After this many single-event 4xx batch rejections in a row, stop and ask for attention instead of emptying the queue into quarantine. */
  maxConsecutiveBatchRejects: 5,
  maxGaps: 100,
  maxQuarantineRecords: 50,
  maxQuarantineRawBytes: 64 * 1024,
} as const

const PREFIX = "linklingo:learn:"
const INDEX_KEY = `${PREFIX}index`
const chunkKey = (id: number) => `${PREFIX}c:${id}`
const quarantineKey = (n: number) => `${PREFIX}q:${n}`
const CHUNK_KEY_RE = /^linklingo:learn:c:(\d+)$/
const QUARANTINE_KEY_RE = /^linklingo:learn:q:(\d+)$/

// ----------------------------------------------------------------- types

export interface CaptureStorage {
  get(key: string): Promise<string | null | undefined>
  set(key: string, value: string): Promise<void>
  delete?(key: string): Promise<void>
  keys?(): Promise<string[]>
}

export interface RejectedEvent {
  eventId: string
  reason: string
  /** True when retrying can never succeed (malformed); false keeps the event queued. */
  permanent: boolean
}

export type SendResult =
  | {kind: "ok"; accepted: string[]; rejected: RejectedEvent[]}
  /** Network, timeout, 5xx, malformed reply: keep everything, back off, resend the same ids. */
  | {kind: "transient"; error: string}
  /** 401 (or a 403 that is not `not_connected`): stop draining until a retry is requested. */
  | {kind: "auth"; error?: string}
  /** 403 `not_connected`: no learning connection paired. */
  | {kind: "not_connected"; error?: string}
  /** The whole batch was refused with a 4xx (400/413/422). The batch is bisected to isolate the offender. */
  | {kind: "batch_rejected"; status: number; error?: string}

export type SendFn = (events: LearningEvent[]) => Promise<SendResult>

export interface CaptureGap {
  reason: "overflow" | "expired"
  sourceSessionId: string
  fromSequence: number
  toSequence: number
  /** capturedAt (UTC ISO) of the first / last lost event. */
  fromAt: string
  toAt: string
  /** Events lost in this gap. */
  count: number
  /** Phone clock (ms) when the loss was recorded. */
  recordedAt: number
}

export type CaptureState = "not_connected" | "paused" | "listening" | "waiting_to_send" | "needs_attention"

export interface CaptureStatus {
  state: CaptureState
  pending: number
  pendingBytes: number
  gaps: CaptureGap[]
  quarantined: number
  lastAcceptedAt: number | null
  lastError: string | null
}

export interface EnqueueInput {
  text: string
  /** Detected language of the recognized text, as reported by the SDK. */
  language?: string | null
  inputLanguage?: string | null
  outputLanguage?: string | null
  mode: CaptureMode
  disposition: CaptureDisposition
  utteranceId?: string
}

export type EnqueueResult =
  | {status: "queued"; eventId: string; sequence: number; sourceSessionId: string}
  /** Capture is toggled off; nothing was stored. */
  | {status: "paused"}
  | {status: "not_connected"}
  | {status: "rejected"; reason: string}
  /** Too large to ever fit the byte cap; recorded as a gap. */
  | {status: "dropped"; reason: string}
  /** Storage failed; nothing was stored. */
  | {status: "error"; error: string}

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface LearningCaptureOptions {
  storage: CaptureStorage
  send: SendFn
  clientVersion: string
  clientBuildId: string
  now?: () => number
  randomId?: () => string
  /** 0..1, used for backoff jitter. */
  random?: () => number
  timezone?: string
  maxBytes?: number
  expiryMs?: number
  batchMaxEvents?: number
  batchMaxBytes?: number
  chunkMaxBytes?: number
  chunkMaxEvents?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  drainDebounceMs?: number
  timers?: Timers
}

// --------------------------------------------------------------- helpers

type ChunkMeta = [id: number, count: number, bytes: number]

interface Index {
  v: 1
  nextChunkId: number
  chunks: ChunkMeta[]
  gaps: CaptureGap[]
  quarantined: number
  qNext: number
  qLow: number
  lastAcceptedAt: number | null
  lastSessionId: string | null
  lastSequence: number
  connected: boolean
}

interface Batch {
  events: LearningEvent[]
  chunkIds: number[]
}

type Attention = "auth" | "not_connected" | "server_rejecting"

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

function eventBytes(event: LearningEvent): number {
  return byteLength(JSON.stringify(event))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A random id that satisfies the contract's id pattern. Prefers crypto.randomUUID, which the background engine provides. */
export function defaultRandomId(): string {
  const c = (globalThis as {crypto?: {randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array}})
    .crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Exponential backoff with "equal" jitter: the delay for the nth consecutive
 * failure is uniform in [cap/2, cap] where cap = min(max, base * 2^(n-1)).
 * `random` is 0..1; random=1 yields the full cap, random=0 half of it.
 */
export function computeBackoffMs(failures: number, baseMs: number, maxMs: number, random: () => number): number {
  const n = Math.max(1, Math.floor(failures))
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(n - 1, 30))
  const r = Math.min(1, Math.max(0, random()))
  return Math.round(exp / 2 + (r * exp) / 2)
}

/**
 * Maps the controller's view of an utterance to the contract's capture mode.
 * Translation mode wins; reverse glosses and plain "heard" are their own
 * modes; everything else (glossed, skipped, short, no candidates, fallback
 * languages) is a gloss-mode utterance that simply was not glossed.
 */
export function captureModeFor(settingsMode: string, disposition: CaptureDisposition): CaptureMode {
  if (settingsMode === "translation" || disposition === "translation_mode") return "translation"
  if (disposition === "reverse_gloss") return "reverse"
  if (disposition === "heard") return "heard"
  return "gloss"
}

function emptyIndex(nextChunkId: number): Index {
  return {
    v: 1,
    nextChunkId,
    chunks: [],
    gaps: [],
    quarantined: 0,
    qNext: 1,
    qLow: 1,
    lastAcceptedAt: null,
    lastSessionId: null,
    lastSequence: 0,
    connected: false,
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function parseIndex(raw: string): Index {
  const v = JSON.parse(raw) as Partial<Index> | null
  if (!v || typeof v !== "object" || v.v !== 1 || !isFiniteNumber(v.nextChunkId) || !Array.isArray(v.chunks)) {
    throw new Error("index shape")
  }
  const chunks: ChunkMeta[] = []
  for (const c of v.chunks) {
    if (!Array.isArray(c) || !isFiniteNumber(c[0]) || !isFiniteNumber(c[1]) || !isFiniteNumber(c[2])) {
      throw new Error("index chunk table")
    }
    chunks.push([c[0], c[1], c[2]])
  }
  return {
    v: 1,
    nextChunkId: v.nextChunkId,
    chunks,
    gaps: Array.isArray(v.gaps) ? v.gaps.filter((g) => g && typeof g === "object") : [],
    quarantined: isFiniteNumber(v.quarantined) ? v.quarantined : 0,
    qNext: isFiniteNumber(v.qNext) ? v.qNext : 1,
    qLow: isFiniteNumber(v.qLow) ? v.qLow : 1,
    lastAcceptedAt: isFiniteNumber(v.lastAcceptedAt) ? v.lastAcceptedAt : null,
    lastSessionId: typeof v.lastSessionId === "string" ? v.lastSessionId : null,
    lastSequence: isFiniteNumber(v.lastSequence) ? v.lastSequence : 0,
    connected: v.connected === true,
  }
}

/** Structural check on a stored event; deliberately light, the server owns full validation. */
function isStoredEvent(e: unknown): e is LearningEvent {
  if (!e || typeof e !== "object") return false
  const o = e as Record<string, unknown>
  return (
    typeof o.eventId === "string" &&
    typeof o.sourceSessionId === "string" &&
    typeof o.text === "string" &&
    o.text.length > 0 &&
    isFiniteNumber(o.sequence) &&
    typeof o.capturedAt === "string"
  )
}

function serializeChunk(id: number, events: LearningEvent[]): string {
  return JSON.stringify({v: 1, id, events})
}

function sumBytes(events: LearningEvent[]): number {
  let total = 0
  for (const e of events) total += eventBytes(e)
  return total
}

const defaultTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

// ------------------------------------------------------------------ class

export class LearningCapture {
  private readonly storage: CaptureStorage
  private readonly sendFn: SendFn
  private readonly now: () => number
  private readonly randomIdFn: () => string
  private readonly random: () => number
  private readonly timers: Timers
  private readonly clientVersion: string
  private readonly clientBuildId: string
  private readonly timezone: string
  private readonly maxBytes: number
  private readonly expiryMs: number
  private readonly batchMaxEvents: number
  private readonly batchMaxBytes: number
  private readonly chunkMaxBytes: number
  private readonly chunkMaxEvents: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly drainDebounceMs: number

  private index: Index | null = null
  /** Newest chunk, cached: it is the only one appended to, and we are its only writer. */
  private tail: {id: number; events: LearningEvent[]} | null = null
  private chain: Promise<unknown> = Promise.resolve()

  private enabled = false
  private listening = false
  private connected = false
  private connectedExplicit = false
  private session: {id: string; next: number} | null = null

  private draining: Promise<void> | null = null
  private drainAgain = false
  private drainTimer: unknown = null
  private retryTimer: unknown = null
  private failures = 0
  private nextAttemptAt = 0
  private lastError: string | null = null
  private storageError: string | null = null
  private attention: Attention | null = null
  private batchCap: number
  private batchRejects = 0
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(options: LearningCaptureOptions) {
    this.storage = options.storage
    this.sendFn = options.send
    this.now = options.now ?? (() => Date.now())
    this.randomIdFn = options.randomId ?? defaultRandomId
    this.random = options.random ?? Math.random
    this.timers = options.timers ?? defaultTimers
    this.clientVersion = options.clientVersion
    this.clientBuildId = options.clientBuildId
    this.timezone = options.timezone ?? DEFAULTS.timezone
    this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes
    this.expiryMs = options.expiryMs ?? DEFAULTS.expiryMs
    this.batchMaxEvents = options.batchMaxEvents ?? DEFAULTS.batchMaxEvents
    this.batchMaxBytes = options.batchMaxBytes ?? DEFAULTS.batchMaxBytes
    this.chunkMaxBytes = options.chunkMaxBytes ?? DEFAULTS.chunkMaxBytes
    this.chunkMaxEvents = options.chunkMaxEvents ?? DEFAULTS.chunkMaxEvents
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULTS.backoffBaseMs
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULTS.backoffMaxMs
    this.drainDebounceMs = options.drainDebounceMs ?? DEFAULTS.drainDebounceMs
    this.batchCap = this.batchMaxEvents
  }

  // ------------------------------------------------------------ lifecycle

  /** Loads the persisted queue. Safe to call repeatedly; schedules a drain when a backlog survived a restart. */
  async init(): Promise<void> {
    try {
      await this.locked(async () => {
        await this.load()
        await this.sweepExpired()
      })
    } catch (err) {
      this.noteStorageError("load", err)
      return
    }
    if (this.pendingCount() > 0) this.scheduleDrain(this.drainDebounceMs)
    this.emit()
  }

  /** Stops timers. Persisted state is untouched. */
  dispose(): void {
    this.disposed = true
    this.clearTimer("drainTimer")
    this.clearTimer("retryTimer")
    this.listeners.clear()
  }

  /** Subscribes to status changes (any mutation). Returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ------------------------------------------------- controller-facing setters

  /** Capture toggle. Off stops NEW enqueues only; the backlog keeps draining. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.emit()
  }

  /** Whether the backend reports a paired learning connection. A restart restores the last known value. */
  setConnected(connected: boolean): void {
    const was = this.connected
    this.connected = connected
    this.connectedExplicit = true
    if (connected !== was || (this.index && this.index.connected !== connected)) {
      void this.locked(async () => {
        if (!this.index || this.index.connected === connected) return
        await this.writeIndex({...this.index, connected})
      }).catch((err) => this.noteStorageError("persist connection", err))
    }
    if (connected && !was) {
      // A fresh pairing is the user's fix for a "not connected" stop.
      if (this.attention === "not_connected") this.clearAttention()
      if (this.pendingCount() > 0) this.scheduleDrain(0)
    }
    this.emit()
  }

  /** Whether the SDK transcript subscription is live. Not evidence of delivery. */
  setListening(listening: boolean): void {
    if (this.listening === listening) return
    this.listening = listening
    this.emit()
  }

  /** Mints a new stable `sourceSessionId`; `sequence` restarts within it. Call once per listening run. */
  startSession(): string {
    const id = this.makeId()
    this.session = {id, next: 1}
    this.emit()
    return id
  }

  // ----------------------------------------------------------------- enqueue

  /**
   * Persists one final segment. Resolves after the storage write has
   * succeeded; the event is then durable even if the WebView, the app, or the
   * network goes away. Never throws.
   */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    try {
      if (!this.enabled) return {status: "paused"}
      if (!this.connected) return {status: "not_connected"}
      if (typeof input.text !== "string" || input.text.trim().length === 0) {
        return {status: "rejected", reason: "empty_text"}
      }
      if (!this.session) this.startSession()
      const session = this.session!
      // Minted ONCE, here, before anything is persisted. Retries reuse it.
      const eventId = this.makeId()
      const sequence = session.next++
      const event: LearningEvent = {
        schemaVersion: LEARNING_SCHEMA_VERSION,
        source: "linklingo",
        sourceSessionId: session.id,
        eventId,
        ...(input.utteranceId ? {utteranceId: input.utteranceId.slice(0, 100)} : {}),
        sequence,
        capturedAt: new Date(this.now()).toISOString(),
        timezone: this.timezone,
        text: input.text,
        detectedLanguage: input.language ?? null,
        inputLanguage: input.inputLanguage ?? null,
        outputLanguage: input.outputLanguage ?? null,
        mode: input.mode,
        disposition: input.disposition,
        speakerAttribution: "unknown",
        clientVersion: this.clientVersion.slice(0, 40),
        clientBuildId: this.clientBuildId.slice(0, 60),
      }
      const result = await this.locked(() => this.append(event))
      if (result.status === "queued") this.scheduleDrain(this.drainDebounceMs)
      this.emit()
      return result
    } catch (err) {
      this.noteStorageError("enqueue", err)
      this.emit()
      return {status: "error", error: errorMessage(err)}
    }
  }

  // ------------------------------------------------------------------ status

  status(): CaptureStatus {
    const idx = this.index
    return {
      state: this.computeState(),
      pending: this.pendingCount(),
      pendingBytes: this.pendingBytes(),
      gaps: idx ? idx.gaps.map((g) => ({...g})) : [],
      quarantined: idx ? idx.quarantined : 0,
      lastAcceptedAt: idx ? idx.lastAcceptedAt : null,
      lastError: this.lastError ?? this.storageError,
    }
  }

  private computeState(): CaptureState {
    if (!this.connected) return "not_connected"
    if (this.attention || this.storageError) return "needs_attention"
    if (this.failures > 0 && this.pendingCount() > 0) return "waiting_to_send"
    if (this.enabled && this.listening) return "listening"
    return "paused"
  }

  private pendingCount(): number {
    let n = 0
    for (const c of this.index?.chunks ?? []) n += c[1]
    return n
  }

  private pendingBytes(): number {
    let n = 0
    for (const c of this.index?.chunks ?? []) n += c[2]
    return n
  }

  // ------------------------------------------------------------------- drain

  /**
   * Sends queued events oldest-first in bounded batches until the queue is
   * empty or a failure occurs. Single-flight: a call during a drain joins it.
   * Respects backoff and a needs-attention stop unless `force` is set.
   */
  drain(options: {force?: boolean} = {}): Promise<void> {
    if (this.draining) {
      this.drainAgain = true
      return this.draining
    }
    const run = (async () => {
      try {
        do {
          this.drainAgain = false
          await this.drainPass(options.force === true)
        } while (this.drainAgain && !this.disposed)
      } finally {
        this.draining = null
      }
    })()
    this.draining = run
    return run
  }

  /**
   * "Try again now": clears backoff and a needs-attention stop (a refreshed
   * token, a re-opened app, a restored connection) and drains. The caller
   * decides when; the controller does so on foreground and auth updates.
   */
  retryNow(): Promise<void> {
    this.clearAttention()
    this.nextAttemptAt = 0
    this.emit()
    return this.drain({force: true})
  }

  private clearAttention(): void {
    this.attention = null
    this.batchRejects = 0
    if (
      this.lastError === "auth_failed" ||
      this.lastError === "not_connected" ||
      this.lastError === "server_rejecting"
    ) {
      this.lastError = null
    }
  }

  private async drainPass(force: boolean): Promise<void> {
    if (this.disposed) return
    try {
      await this.locked(() => this.load())
    } catch (err) {
      this.noteStorageError("load", err)
      return
    }
    if (!this.connected) return
    if (this.attention) return
    if (!force && this.now() < this.nextAttemptAt) {
      this.scheduleRetry(this.nextAttemptAt - this.now())
      return
    }
    for (;;) {
      if (this.disposed) return
      let batch: Batch | null
      try {
        batch = await this.locked(async () => {
          await this.sweepExpired()
          return this.nextBatch()
        })
      } catch (err) {
        this.noteStorageError("read queue", err)
        return
      }
      if (!batch || batch.events.length === 0) return

      let result: SendResult
      try {
        result = await this.sendFn(batch.events)
      } catch (err) {
        result = {kind: "transient", error: errorMessage(err)}
      }

      let proceed: boolean
      try {
        proceed = await this.locked(() => this.applyResult(batch!, result))
      } catch (err) {
        // The server may have stored the batch; the local ack failed. The
        // events stay queued and are resent with the same ids (deduplicated).
        this.noteStorageError("ack", err)
        return
      }
      this.emit()
      if (!proceed) return
    }
  }

  /** Reads events from the head of the queue until a batch limit is hit. Called under the lock. */
  private async nextBatch(): Promise<Batch | null> {
    const events: LearningEvent[] = []
    const chunkIds: number[] = []
    let bytes = 0
    const limit = Math.max(1, Math.min(this.batchMaxEvents, this.batchCap))
    // Index can change underneath us when a corrupt chunk is removed; walk by id.
    let cursor = 0
    while (cursor < (this.index?.chunks.length ?? 0)) {
      const meta = this.index!.chunks[cursor]!
      const chunk = await this.readChunk(meta[0])
      if (chunk === null) continue // removed; the same cursor now points at the next chunk
      let usedFromChunk = 0
      for (const e of chunk) {
        const size = eventBytes(e)
        if (events.length >= limit) break
        if (events.length > 0 && bytes + size > this.batchMaxBytes) break
        events.push(e)
        bytes += size
        usedFromChunk++
      }
      if (usedFromChunk > 0) chunkIds.push(meta[0])
      if (usedFromChunk < chunk.length) break
      cursor++
    }
    return events.length > 0 ? {events, chunkIds} : null
  }

  /** Applies a send result to the queue. Returns true when the drain loop should continue. Called under the lock. */
  private async applyResult(batch: Batch, result: SendResult): Promise<boolean> {
    switch (result.kind) {
      case "ok": {
        const accepted = new Set(result.accepted)
        const permanent = new Map<string, string>()
        const transient: string[] = []
        for (const r of result.rejected) {
          if (r.permanent) permanent.set(r.eventId, r.reason)
          else transient.push(`${r.eventId}: ${r.reason}`)
        }
        // An id both accepted and rejected is committed; accepted wins.
        for (const id of accepted) permanent.delete(id)
        const outcome = await this.settle(batch, accepted, permanent)
        if (outcome.accepted > 0) {
          this.lastError = null
          this.storageError = null
        }
        const progress = batch.events.filter((e) => accepted.has(e.eventId) || permanent.has(e.eventId)).length
        const leftover = batch.events.length - progress
        diagnostics.increment("learning.accepted", outcome.accepted)
        if (outcome.quarantined > 0) diagnostics.increment("learning.rejected_permanent", outcome.quarantined)
        if (leftover > 0 && progress === 0) {
          this.registerFailure(transient.length > 0 ? `rejected: ${transient[0]}` : "no events acknowledged")
          return false
        }
        if (leftover > 0) {
          // Partial progress: keep going; the stragglers go again next pass and
          // trip the no-progress branch above if they keep failing.
          this.failures = 0
        } else {
          this.failures = 0
          this.lastError = null
        }
        this.nextAttemptAt = 0
        this.batchRejects = 0
        this.batchCap = Math.min(this.batchMaxEvents, this.batchCap * 2)
        return true
      }
      case "transient":
        this.registerFailure(result.error || "transient failure")
        return false
      case "auth":
        this.attention = "auth"
        this.lastError = "auth_failed"
        log.warn("learning delivery stopped: auth failure", {detail: result.error})
        diagnostics.increment("learning.auth_failures")
        return false
      case "not_connected":
        this.attention = "not_connected"
        this.lastError = "not_connected"
        log.warn("learning delivery stopped: not connected", {detail: result.error})
        diagnostics.increment("learning.not_connected")
        return false
      case "batch_rejected": {
        diagnostics.increment("learning.batch_rejected")
        if (batch.events.length > 1) {
          // Bisect to find the event the server refuses, without penalising the rest.
          this.batchCap = Math.max(1, Math.floor(batch.events.length / 2))
          return true
        }
        this.batchRejects++
        if (this.batchRejects > DEFAULTS.maxConsecutiveBatchRejects) {
          this.attention = "server_rejecting"
          this.lastError = "server_rejecting"
          log.error("learning delivery stopped: server rejects every event", {status: result.status})
          return false
        }
        const only = batch.events[0]!
        const outcome = await this.settle(batch, new Set(), new Map([[only.eventId, `http_${result.status}`]]))
        diagnostics.increment("learning.rejected_permanent", outcome.quarantined)
        return true
      }
    }
  }

  private registerFailure(error: string): void {
    this.failures++
    this.lastError = error
    const delay = computeBackoffMs(this.failures, this.backoffBaseMs, this.backoffMaxMs, this.random)
    this.nextAttemptAt = this.now() + delay
    diagnostics.increment("learning.send_failures")
    log.warn("learning delivery failed; backing off", {failures: this.failures, delayMs: delay, error})
    this.scheduleRetry(delay)
  }

  /**
   * Removes acknowledged events and quarantines permanently rejected ones, in
   * one index commit. Called under the lock. Index is committed BEFORE the
   * chunk bodies so a crash in between resurrects events (re-sent and
   * deduplicated by id) rather than losing any.
   */
  private async settle(
    batch: Batch,
    accepted: Set<string>,
    permanent: Map<string, string>,
  ): Promise<{accepted: number; quarantined: number}> {
    // Read first: readChunk can rewrite the index when it finds corruption, and the draft must start from that.
    const loaded: Array<{id: number; events: LearningEvent[]}> = []
    for (const id of batch.chunkIds) {
      if (!this.index!.chunks.some((c) => c[0] === id)) continue // dropped meanwhile (overflow/expiry)
      const events = await this.readChunk(id)
      if (events !== null) loaded.push({id, events})
    }
    const draft = this.draft()
    const writes: Array<{id: number; events: LearningEvent[]}> = []
    let acceptedCount = 0
    let quarantinedCount = 0
    for (const {id, events} of loaded) {
      const keep: LearningEvent[] = []
      for (const e of events) {
        if (accepted.has(e.eventId)) {
          acceptedCount++
        } else if (permanent.has(e.eventId)) {
          await this.writeQuarantine(draft, {kind: "event", reason: permanent.get(e.eventId)!, event: e}, 1)
          quarantinedCount++
        } else {
          keep.push(e)
        }
      }
      if (keep.length !== events.length) {
        this.applyChunkMeta(draft, id, keep)
        writes.push({id, events: keep})
      }
    }
    if (acceptedCount > 0) draft.lastAcceptedAt = this.now()
    if (writes.length === 0 && acceptedCount === 0) return {accepted: 0, quarantined: 0}
    await this.writeIndex(draft)
    for (const w of writes) await this.writeChunkBody(w.id, w.events)
    return {accepted: acceptedCount, quarantined: quarantinedCount}
  }

  // ------------------------------------------------------------- scheduling

  private scheduleDrain(ms: number): void {
    if (this.disposed || this.drainTimer !== null) return
    this.drainTimer = this.timers.set(
      () => {
        this.drainTimer = null
        void this.drain().catch((err) => log.warn("scheduled drain failed", {error: err as Error}))
      },
      Math.max(0, ms),
    )
  }

  private scheduleRetry(ms: number): void {
    if (this.disposed) return
    this.clearTimer("retryTimer")
    this.retryTimer = this.timers.set(
      () => {
        this.retryTimer = null
        void this.drain().catch((err) => log.warn("retry drain failed", {error: err as Error}))
      },
      Math.max(0, ms),
    )
  }

  private clearTimer(name: "drainTimer" | "retryTimer"): void {
    if (this[name] !== null) {
      this.timers.clear(this[name])
      this[name] = null
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (err) {
        log.warn("status listener threw", {error: err as Error})
      }
    }
  }

  private noteStorageError(what: string, err: unknown): void {
    this.storageError = `storage ${what} failed: ${errorMessage(err)}`
    diagnostics.increment("learning.storage_errors")
    log.error("learning storage error", {what, error: err as Error})
  }

  private makeId(): string {
    let id = ""
    try {
      id = this.randomIdFn()
    } catch {
      id = ""
    }
    return ID_PATTERN.test(id) ? id : defaultRandomId()
  }

  // ----------------------------------------------------------------- the lock

  /** Serializes every queue mutation. The chain itself never rejects. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => fn())
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ------------------------------------------------------------ load/recover

  private async load(): Promise<void> {
    if (this.index) return
    const raw = await this.storage.get(INDEX_KEY)
    let index: Index
    if (raw) {
      try {
        index = parseIndex(raw)
      } catch (err) {
        index = await this.recoverIndex(raw, err)
      }
    } else {
      index = emptyIndex(1)
    }
    this.index = index
    this.storageError = null

    // Adopt chunks written just before a crash but never indexed.
    for (;;) {
      const id = this.index.nextChunkId
      const body = await this.storage.get(chunkKey(id))
      if (!body) break
      const draft = this.draft()
      draft.nextChunkId = id + 1
      let events: LearningEvent[] | null = null
      try {
        events = this.parseChunk(body).valid
      } catch {
        await this.writeQuarantine(draft, {kind: "chunk", reason: "chunk_corrupt", chunkId: id, raw: body}, 1)
        await this.deleteKey(chunkKey(id))
      }
      if (events && events.length > 0) draft.chunks.push([id, events.length, sumBytes(events)])
      await this.writeIndex(draft)
    }

    // Reconcile the two chunks that can differ from the table after a crash.
    const ids = new Set<number>()
    const first = this.index.chunks[0]
    const last = this.index.chunks[this.index.chunks.length - 1]
    if (first) ids.add(first[0])
    if (last) ids.add(last[0])
    for (const id of ids) {
      if (!this.index.chunks.some((c) => c[0] === id)) continue
      const events = await this.readChunk(id)
      if (events === null) continue
      const meta = this.index.chunks.find((c) => c[0] === id)
      const bytes = sumBytes(events)
      if (meta && (meta[1] !== events.length || meta[2] !== bytes)) {
        const draft = this.draft()
        this.applyChunkMeta(draft, id, events)
        await this.writeIndex(draft)
        diagnostics.increment("learning.reconciled")
      }
    }

    if (!this.connectedExplicit) this.connected = this.index.connected
    else if (this.index.connected !== this.connected) await this.writeIndex({...this.index, connected: this.connected})
  }

  /** The index is unreadable: quarantine it and rebuild the chunk table from whatever chunk keys exist. */
  private async recoverIndex(raw: string, cause: unknown): Promise<Index> {
    diagnostics.increment("learning.index_recovered")
    log.error("learning index unreadable; rebuilding", {error: cause as Error})
    const index = emptyIndex(Math.floor(this.now() / 1000))
    index.quarantined = 0
    if (this.storage.keys) {
      const keys = await this.storage.keys()
      const qs = keys
        .map((k) => QUARANTINE_KEY_RE.exec(k))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
      if (qs.length > 0) {
        index.qLow = Math.min(...qs)
        index.qNext = Math.max(...qs) + 1
      }
      const ids = keys
        .map((k) => CHUNK_KEY_RE.exec(k))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
        .sort((a, b) => a - b)
      index.nextChunkId = ids.length > 0 ? ids[ids.length - 1]! + 1 : 1
      for (const id of ids) {
        const body = await this.storage.get(chunkKey(id))
        if (!body) continue
        try {
          const {valid} = this.parseChunk(body)
          if (valid.length > 0) index.chunks.push([id, valid.length, sumBytes(valid)])
        } catch {
          await this.writeQuarantine(index, {kind: "chunk", reason: "chunk_corrupt", chunkId: id, raw: body}, 1)
          await this.deleteKey(chunkKey(id))
        }
      }
    }
    await this.writeQuarantine(index, {kind: "index", reason: "index_corrupt", raw}, 1)
    this.lastError = "index_corrupt_recovered"
    await this.storage.set(INDEX_KEY, JSON.stringify(index))
    return index
  }

  // ---------------------------------------------------------------- chunks

  private lastChunkId(): number | null {
    const last = this.index?.chunks[this.index.chunks.length - 1]
    return last ? last[0] : null
  }

  /** Copy-on-write snapshot of the index for mutation. */
  private draft(): Index {
    const i = this.index!
    return {...i, chunks: i.chunks.map((c) => [c[0], c[1], c[2]] as ChunkMeta), gaps: i.gaps.map((g) => ({...g}))}
  }

  private async writeIndex(next: Index): Promise<void> {
    await this.storage.set(INDEX_KEY, JSON.stringify(next))
    this.index = next
    this.storageError = null
  }

  private async deleteKey(key: string): Promise<void> {
    try {
      if (this.storage.delete) await this.storage.delete(key)
      else await this.storage.set(key, "")
    } catch (err) {
      log.warn("could not delete learning key", {key, error: err as Error})
    }
  }

  private parseChunk(body: string): {valid: LearningEvent[]; invalid: unknown[]} {
    const parsed = JSON.parse(body) as {events?: unknown} | null
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) throw new Error("chunk shape")
    const valid: LearningEvent[] = []
    const invalid: unknown[] = []
    for (const e of parsed.events) {
      if (isStoredEvent(e)) valid.push(e)
      else invalid.push(e)
    }
    return {valid, invalid}
  }

  /**
   * Reads and validates one chunk. Returns null when the chunk had to be
   * removed (missing or unparseable); the index is already updated and the
   * loss counted, so callers just re-read the table. Individually malformed
   * events are quarantined and the rest of the chunk is kept.
   */
  private async readChunk(id: number): Promise<LearningEvent[] | null> {
    if (this.tail && this.tail.id === id) return this.tail.events
    const body = await this.storage.get(chunkKey(id))
    const meta = this.index!.chunks.find((c) => c[0] === id)
    if (!body) {
      await this.removeChunkFromIndex(id, meta?.[1] ?? 1, {kind: "chunk", reason: "chunk_missing", chunkId: id})
      return null
    }
    let parsed: {valid: LearningEvent[]; invalid: unknown[]}
    try {
      parsed = this.parseChunk(body)
    } catch {
      await this.removeChunkFromIndex(id, meta?.[1] ?? 1, {
        kind: "chunk",
        reason: "chunk_corrupt",
        chunkId: id,
        raw: body,
      })
      await this.deleteKey(chunkKey(id))
      return null
    }
    let events = parsed.valid
    if (parsed.invalid.length > 0) {
      const draft = this.draft()
      for (const bad of parsed.invalid) {
        await this.writeQuarantine(
          draft,
          {kind: "event", reason: "event_corrupt", chunkId: id, raw: JSON.stringify(bad)},
          1,
        )
      }
      this.applyChunkMeta(draft, id, events)
      await this.writeIndex(draft)
      await this.writeChunkBody(id, events)
      events = this.index!.chunks.some((c) => c[0] === id) ? events : []
    }
    if (this.lastChunkId() === id) this.tail = {id, events}
    return events
  }

  private async removeChunkFromIndex(id: number, lostEvents: number, record: Record<string, unknown>): Promise<void> {
    const draft = this.draft()
    await this.writeQuarantine(draft, record, lostEvents)
    draft.chunks = draft.chunks.filter((c) => c[0] !== id)
    await this.writeIndex(draft)
    if (this.tail?.id === id) this.tail = null
    diagnostics.increment("learning.chunks_quarantined")
    log.error("learning chunk removed", {id, reason: record.reason as string, events: lostEvents})
  }

  /** Updates (or removes, when empty) a chunk's row in a draft index. */
  private applyChunkMeta(draft: Index, id: number, events: LearningEvent[]): void {
    const at = draft.chunks.findIndex((c) => c[0] === id)
    if (at < 0) return
    if (events.length === 0) draft.chunks.splice(at, 1)
    else draft.chunks[at] = [id, events.length, sumBytes(events)]
  }

  /** Best-effort chunk body write after the index already reflects it. */
  private async writeChunkBody(id: number, events: LearningEvent[]): Promise<void> {
    try {
      if (events.length === 0) {
        if (this.storage.delete) await this.storage.delete(chunkKey(id))
        else await this.storage.set(chunkKey(id), serializeChunk(id, []))
      } else {
        await this.storage.set(chunkKey(id), serializeChunk(id, events))
      }
    } catch (err) {
      // The index is already authoritative; the next load reconciles.
      log.warn("learning chunk body write failed after index commit", {id, error: err as Error})
      diagnostics.increment("learning.chunk_write_after_index_failed")
    }
    if (this.lastChunkId() === id) this.tail = {id, events}
    else if (this.tail?.id === id) this.tail = null
  }

  /** Writes a quarantine record and updates the draft's counters. The caller commits the draft. */
  private async writeQuarantine(draft: Index, record: Record<string, unknown>, count: number): Promise<void> {
    const n = draft.qNext++
    let body = {...record, at: this.now(), count} as Record<string, unknown>
    if (typeof body.raw === "string" && body.raw.length > DEFAULTS.maxQuarantineRawBytes) {
      body = {...body, raw: (body.raw as string).slice(0, DEFAULTS.maxQuarantineRawBytes), truncated: true}
    }
    try {
      await this.storage.set(quarantineKey(n), JSON.stringify(body))
    } catch (err) {
      log.error("could not write quarantine record", {error: err as Error})
    }
    draft.quarantined += count
    while (draft.qNext - draft.qLow > DEFAULTS.maxQuarantineRecords) {
      await this.deleteKey(quarantineKey(draft.qLow))
      draft.qLow++
    }
  }

  // -------------------------------------------------------- append/overflow

  /** Appends one event to the tail chunk. Called under the lock. */
  private async append(event: LearningEvent): Promise<EnqueueResult> {
    await this.load()
    const size = eventBytes(event)
    if (event.text.length > MAX_EVENT_TEXT) {
      // The contract would reject it permanently; keep the text, count it, never retry it.
      const draft = this.draft()
      await this.writeQuarantine(draft, {kind: "event", reason: "text_too_long", event}, 1)
      await this.writeIndex(draft)
      return {status: "rejected", reason: "text_too_long"}
    }
    if (size > this.maxBytes) {
      const draft = this.draft()
      this.recordGap(draft, [event], "overflow")
      await this.writeIndex(draft)
      return {status: "dropped", reason: "event_larger_than_queue"}
    }

    let tailId = this.lastChunkId()
    let events = tailId !== null ? await this.readChunk(tailId) : null
    tailId = this.lastChunkId()
    const meta = tailId !== null ? this.index!.chunks[this.index!.chunks.length - 1]! : null
    const draft = this.draft()
    let chunkId: number
    let nextEvents: LearningEvent[]
    if (meta && events && meta[1] < this.chunkMaxEvents && (meta[1] === 0 || meta[2] + size <= this.chunkMaxBytes)) {
      chunkId = meta[0]
      nextEvents = [...events, event]
      this.applyChunkMeta(draft, chunkId, nextEvents)
    } else {
      chunkId = draft.nextChunkId++
      nextEvents = [event]
      draft.chunks.push([chunkId, 1, size])
    }
    draft.lastSessionId = event.sourceSessionId
    draft.lastSequence = event.sequence

    // Chunk first, index second: a crash in between leaves an adoptable chunk, never a lost event.
    await this.storage.set(chunkKey(chunkId), serializeChunk(chunkId, nextEvents))
    await this.writeIndex(draft)
    this.tail = {id: chunkId, events: nextEvents}

    try {
      await this.trimToCap()
    } catch (err) {
      // The event is safely stored; trimming retries on the next enqueue.
      log.warn("could not trim learning queue", {error: err as Error})
    }
    return {status: "queued", eventId: event.eventId, sequence: event.sequence, sourceSessionId: event.sourceSessionId}
  }

  /** Drops the oldest events until pending bytes fit the cap, recording each loss as a gap. Under the lock. */
  private async trimToCap(): Promise<void> {
    for (let guard = 0; guard < 10_000 && this.pendingBytes() > this.maxBytes; guard++) {
      const head = this.index!.chunks[0]
      if (!head) return
      const events = await this.readChunk(head[0])
      if (events === null) continue
      const excess = this.pendingBytes() - this.maxBytes
      let k = 0
      let freed = 0
      for (const e of events) {
        if (freed >= excess) break
        freed += eventBytes(e)
        k++
      }
      // Never drop the newest event of the whole queue.
      if (this.index!.chunks.length === 1) k = Math.min(k, events.length - 1)
      if (k <= 0) return
      await this.dropLeading(head[0], events, k, "overflow")
    }
  }

  /** Removes the first `k` events of the head chunk and records them as a gap. Under the lock. */
  private async dropLeading(
    chunkId: number,
    events: LearningEvent[],
    k: number,
    reason: CaptureGap["reason"],
  ): Promise<void> {
    const dropped = events.slice(0, k)
    const rest = events.slice(k)
    const draft = this.draft()
    this.recordGap(draft, dropped, reason)
    this.applyChunkMeta(draft, chunkId, rest)
    diagnostics.increment(
      reason === "overflow" ? "learning.dropped_overflow" : "learning.dropped_expired",
      dropped.length,
    )
    log.warn("learning events dropped", {reason, count: dropped.length})
    await this.writeIndex(draft)
    await this.writeChunkBody(chunkId, rest)
  }

  /** Drops events older than the expiry window, head first. Under the lock. */
  private async sweepExpired(): Promise<void> {
    await this.load()
    const cutoff = this.now() - this.expiryMs
    for (let guard = 0; guard < 10_000; guard++) {
      const head = this.index!.chunks[0]
      if (!head) return
      const events = await this.readChunk(head[0])
      if (events === null) continue
      let k = 0
      while (k < events.length && Date.parse(events[k]!.capturedAt) < cutoff) k++
      if (k === 0) return
      await this.dropLeading(head[0], events, k, "expired")
    }
  }

  /** Adds the lost events to a draft index's gap list, merging contiguous losses in one session. */
  private recordGap(draft: Index, dropped: LearningEvent[], reason: CaptureGap["reason"]): void {
    let i = 0
    while (i < dropped.length) {
      let j = i
      while (
        j + 1 < dropped.length &&
        dropped[j + 1]!.sourceSessionId === dropped[i]!.sourceSessionId &&
        dropped[j + 1]!.sequence === dropped[j]!.sequence + 1
      ) {
        j++
      }
      const first = dropped[i]!
      const last = dropped[j]!
      const count = j - i + 1
      const prev = draft.gaps[draft.gaps.length - 1]
      if (
        prev &&
        prev.reason === reason &&
        prev.sourceSessionId === first.sourceSessionId &&
        prev.toSequence + 1 === first.sequence
      ) {
        prev.toSequence = last.sequence
        prev.toAt = last.capturedAt
        prev.count += count
        prev.recordedAt = this.now()
      } else {
        draft.gaps.push({
          reason,
          sourceSessionId: first.sourceSessionId,
          fromSequence: first.sequence,
          toSequence: last.sequence,
          fromAt: first.capturedAt,
          toAt: last.capturedAt,
          count,
          recordedAt: this.now(),
        })
      }
      i = j + 1
    }
    while (draft.gaps.length > DEFAULTS.maxGaps) {
      // Fold the two oldest records into one covering both: the loss stays visible, just coarser.
      const [a, b] = draft.gaps
      draft.gaps.splice(0, 2, {
        reason: a!.reason === b!.reason ? a!.reason : "overflow",
        sourceSessionId: a!.sourceSessionId,
        fromSequence: a!.fromSequence,
        toSequence: a!.sourceSessionId === b!.sourceSessionId ? b!.toSequence : a!.toSequence,
        fromAt: a!.fromAt,
        toAt: b!.toAt,
        count: a!.count + b!.count,
        recordedAt: b!.recordedAt,
      })
    }
  }
}
