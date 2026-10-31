/**
 * Daily full-transcript vocabulary sweep.
 *
 * Unlike live glossing, this deliberately gives the JSON LLM every saved line
 * from a completed China-local day. The model selects broadly; Mandarin owns
 * known/rejected filtering. Generated batches and run checkpoints live beside
 * the learning outbox, so pod restarts replay the exact same batch id/body.
 */

import {createHash} from "node:crypto"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {generateJson, resolveAnalystModel, resolveAnalystProvider, resolveApiKey} from "./gemini"
import {lookupRank} from "./frequency"
import {toPinyin} from "./pinyin"
import {ObjectTape, type ObjectStore} from "./tape-store"
import type {TranscriptEntry} from "./transcript-log"
import {VOCABULARY_BATCH_SCHEMA_VERSION, type VocabularyBatch, type VocabularyCandidate} from "./vocabulary-contract"

const log = createLogger("vocabulary-scan")

const CHINA_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 24 * 3_600_000
const SESSION_GAP_MS = 30 * 60_000
const FIRST_RUN_MS = 2 * 60_000
const LOOP_MS = 60 * 60_000
const DEFAULT_CATCHUP_DAYS = 7
const MAX_CATCHUP_DAYS = 31
const MAX_PROMPT_CHARS = 30_000
const MAX_CONTEXTS = 5
const MAX_REASON_CHARS = 300

const SCAN_SYSTEM = `You identify Mandarin vocabulary that may be hard for a learner from complete smart-glasses transcripts.

Read every supplied line. Select broadly: useful Mandarin words, idioms, fixed collocations, and short phrases that a learner may not know. Do not limit yourself to preselected frequency candidates. The receiving Mandarin app will remove words already known or previously rejected, so prefer recall over precision.

Rules:
- "word" must be an exact contiguous substring copied from the transcript.
- Return Mandarin vocabulary only, normally 1-8 Hanzi; include a longer phrase only when it is a reusable fixed expression.
- Exclude names, numbers, recognition garbage, whole sentences, and trivial function words.
- Give a concise English meaning for the sense used in context.
- "reasons" should explain why it is worth reviewing (rarity, idiom, specialized sense, useful collocation, repeated use).
- Confidence is about whether this is a real reusable vocabulary item in the supplied context, not whether the learner knows it.
- Collect broadly. An empty list is valid only when the chunk contains no useful Mandarin vocabulary.

Return JSON only: {"candidates":[{"word":"斟酌","pinyin":"zhēn zhuó","english":"to weigh carefully","reasons":["formal verb used in context"],"confidence":"high"}]}`

const SCAN_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          word: {type: "string"},
          pinyin: {type: "string"},
          english: {type: "string"},
          reasons: {type: "array", items: {type: "string"}},
          confidence: {type: "string", enum: ["high", "medium", "low"]},
        },
        required: ["word", "pinyin", "english", "reasons", "confidence"],
      },
    },
  },
  required: ["candidates"],
}

type Generate = (opts: Parameters<typeof generateJson>[0]) => Promise<{text: string}>

export interface VocabularyDeliveryResult {
  outcome: "accepted" | "duplicate" | "not_connected" | "retry_later" | "revoked" | "needs_attention"
  error?: string
}

export interface VocabularyDelivery {
  deliverVocabularyBatch(transcriptUser: string, batch: VocabularyBatch): Promise<VocabularyDeliveryResult>
}

export interface VocabularyScannerDeps {
  store: ObjectStore
  delivery: VocabularyDelivery
  generate?: Generate
  now?: () => number
  enabled?: () => boolean
  catchupDays?: number
}

export interface StoredVocabularyBatch {
  v: 1
  transcriptUser: string
  status: "ready" | "delivered" | "complete"
  batch: VocabularyBatch
  deliveryAttempts: number
  lastDeliveryError: string | null
  deliveredAt: string | null
}

interface DailyRunCheckpoint {
  v: 1
  localDate: string
  status: "complete" | "partial"
  startedAt: string
  completedAt: string
  transcriptCount: number
  users: number
  failedUsers: string[]
}

interface ProposedCandidate {
  word: string
  pinyin: string
  english: string
  reasons: string[]
  confidence: "high" | "medium" | "low"
}

interface SessionEntry {
  entry: TranscriptEntry
  sessionId: string
}

const batchPrefix = (date?: string) => `learning/vocabulary/batches/${date ? `${date}/` : ""}`
const batchKey = (date: string, user: string) => `${batchPrefix(date)}${user}.json`
const runKey = (date: string) => `learning/vocabulary/runs/${date}.json`

function clip(value: unknown, max: number): string {
  return [
    ...String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, max)
    .join("")
}

function safeJson(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Most recent fully completed calendar day in Asia/Shanghai. */
export function previousCompleteChinaDate(now = Date.now()): string {
  const today = new Date(now + CHINA_OFFSET_MS).toISOString().slice(0, 10)
  return shiftDate(today, -1)
}

/** Inclusive start and exclusive end for a China-local YYYY-MM-DD. */
export function chinaDayBounds(date: string): {from: number; to: number} {
  const from = Date.parse(`${date}T00:00:00+08:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(from)) throw new Error(`invalid local date: ${date}`)
  return {from, to: from + DAY_MS}
}

function stableBatchId(user: string, date: string): string {
  return `llv_${createHash("sha256").update(`linklingo-vocabulary-v1|${user}|${date}`).digest("hex").slice(0, 32)}`
}

function confidenceScore(value: ProposedCandidate["confidence"]): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1
}

function countOccurrences(text: string, word: string): number {
  let count = 0
  let at = 0
  while (word && (at = text.indexOf(word, at)) >= 0) {
    count++
    at += word.length
  }
  return count
}

function inferSessions(entries: TranscriptEntry[], date: string): SessionEntry[] {
  const sorted = [...entries].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  let session = 0
  let previous: number | null = null
  return sorted.map((entry) => {
    if (previous == null || entry.at - previous > SESSION_GAP_MS) session++
    previous = entry.at
    return {entry, sessionId: `${date}-s${String(session).padStart(3, "0")}`}
  })
}

function promptChunks(entries: TranscriptEntry[]): string[] {
  const lines = entries
    .filter((entry) => entry.text.trim())
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((entry) => `${new Date(entry.at).toISOString()} ${entry.text.replace(/\s+/g, " ").trim()}`)
  const chunks: string[] = []
  let current = ""
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_PROMPT_CHARS) {
      chunks.push(current)
      current = ""
    }
    current += `${current ? "\n" : ""}${line}`
  }
  if (current) chunks.push(current)
  return chunks
}

function sanitizeProposals(raw: unknown, corpus: string): ProposedCandidate[] {
  const items = Array.isArray((raw as {candidates?: unknown})?.candidates)
    ? (raw as {candidates: unknown[]}).candidates
    : []
  const out: ProposedCandidate[] = []
  for (const item of items) {
    const value = item as Record<string, unknown>
    const word = clip(value.word, 40)
    const english = clip(value.english, 240)
    if (!word || !english || !/[\u3400-\u9fff]/.test(word) || !corpus.includes(word)) continue
    const reasons = (Array.isArray(value.reasons) ? value.reasons : [value.reasons])
      .map((reason) => clip(reason, MAX_REASON_CHARS))
      .filter(Boolean)
      .slice(0, 6)
    if (!reasons.length) reasons.push("Potentially useful Mandarin vocabulary from this day's transcript.")
    const confidence = value.confidence === "high" || value.confidence === "medium" ? value.confidence : "low"
    out.push({
      word,
      pinyin: clip(value.pinyin, 160) || toPinyin(word),
      english,
      reasons,
      confidence,
    })
  }
  return out
}

function mergeProposals(proposals: ProposedCandidate[]): ProposedCandidate[] {
  const merged = new Map<string, ProposedCandidate>()
  for (const proposal of proposals) {
    const prior = merged.get(proposal.word)
    if (!prior) {
      merged.set(proposal.word, proposal)
      continue
    }
    const preferred = confidenceScore(proposal.confidence) > confidenceScore(prior.confidence) ? proposal : prior
    merged.set(proposal.word, {
      ...preferred,
      reasons: [...new Set([...prior.reasons, ...proposal.reasons])].slice(0, 6),
    })
  }
  return [...merged.values()]
}

function materializeCandidates(proposals: ProposedCandidate[], entries: SessionEntry[]): VocabularyCandidate[] {
  const candidates: VocabularyCandidate[] = []
  for (const proposal of proposals) {
    let totalAppearances = 0
    const sessions = new Set<string>()
    const contexts: VocabularyCandidate["contexts"] = []
    const seenContexts = new Set<string>()
    for (const {entry, sessionId} of entries) {
      const appearances = countOccurrences(entry.text, proposal.word)
      if (!appearances) continue
      totalAppearances += appearances
      sessions.add(sessionId)
      const text = clip(entry.text, 500)
      if (contexts.length < MAX_CONTEXTS && !seenContexts.has(text)) {
        seenContexts.add(text)
        contexts.push({text, capturedAt: new Date(entry.at).toISOString(), sessionId})
      }
    }
    if (!totalAppearances || !contexts.length) continue
    candidates.push({
      word: proposal.word,
      pinyin: toPinyin(proposal.word),
      english: proposal.english,
      corpusRank: lookupRank(proposal.word, "zh"),
      totalAppearances,
      distinctSessions: sessions.size,
      contexts,
      reasons: proposal.reasons,
      confidence: proposal.confidence,
    })
  }
  return candidates.sort(
    (a, b) =>
      confidenceScore(b.confidence) - confidenceScore(a.confidence) ||
      b.distinctSessions - a.distinctSessions ||
      b.totalAppearances - a.totalAppearances ||
      (b.corpusRank ?? 0) - (a.corpusRank ?? 0),
  )
}

export class VocabularyScanner {
  private readonly tape: ObjectTape
  private readonly generate: Generate
  private readonly now: () => number
  private readonly enabled: () => boolean
  private readonly catchupDays: number
  private timer: ReturnType<typeof setInterval> | null = null
  private firstRun: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private readonly deps: VocabularyScannerDeps) {
    this.tape = new ObjectTape(deps.store)
    this.generate = deps.generate ?? generateJson
    this.now = deps.now ?? (() => Date.now())
    this.enabled = deps.enabled ?? (() => Boolean(resolveApiKey()))
    this.catchupDays = Math.max(1, Math.min(deps.catchupDays ?? DEFAULT_CATCHUP_DAYS, MAX_CATCHUP_DAYS))
  }

  start(): void {
    if (this.timer) return
    this.firstRun = setTimeout(() => void this.runOnce(), FIRST_RUN_MS)
    this.firstRun.unref?.()
    this.timer = setInterval(() => void this.runOnce(), LOOP_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.firstRun) clearTimeout(this.firstRun)
    if (this.timer) clearInterval(this.timer)
    this.firstRun = null
    this.timer = null
  }

  /** Oldest missed day first, ending at yesterday in Asia/Shanghai. */
  async runOnce(now = this.now()): Promise<number> {
    if (this.running || !this.enabled()) return 0
    this.running = true
    let completed = 0
    try {
      const latest = previousCompleteChinaDate(now)
      for (let offset = this.catchupDays - 1; offset >= 0; offset--) {
        const result = await this.runDay(shiftDate(latest, -offset), now)
        if (result === "complete") completed++
      }
    } finally {
      this.running = false
    }
    return completed
  }

  async runDay(date: string, now = this.now()): Promise<"complete" | "partial"> {
    const prior = safeJson(await this.deps.store.get(runKey(date))) as DailyRunCheckpoint | null
    if (prior?.status === "complete") {
      await this.retryDeliveries(date, now)
      return "complete"
    }

    const startedAt = new Date(now).toISOString()
    const {from, to} = chinaDayBounds(date)
    const all = (await this.tape.loadRange("transcript", from, to - 1)) as TranscriptEntry[]
    const byUser = new Map<string, TranscriptEntry[]>()
    for (const entry of all) {
      if (!entry.user || !entry.text?.trim()) continue
      const list = byUser.get(entry.user) ?? []
      list.push(entry)
      byUser.set(entry.user, list)
    }

    const failedUsers: string[] = []
    for (const [user, entries] of byUser) {
      try {
        let stored = await this.loadBatch(date, user)
        if (!stored) {
          stored = await this.scanUser(date, user, entries, now)
          await this.saveBatch(stored)
        }
        await this.deliver(stored, now)
      } catch (error) {
        failedUsers.push(user)
        metrics.increment("vocabulary_scans_total", {outcome: "user_error"})
        log.warn("user vocabulary scan failed", {date, user, error: String(error)})
      }
    }

    const status = failedUsers.length ? "partial" : "complete"
    const checkpoint: DailyRunCheckpoint = {
      v: 1,
      localDate: date,
      status,
      startedAt: prior?.startedAt ?? startedAt,
      completedAt: new Date(now).toISOString(),
      transcriptCount: all.length,
      users: byUser.size,
      failedUsers,
    }
    await this.deps.store.put(runKey(date), JSON.stringify(checkpoint))
    metrics.increment("vocabulary_scans_total", {outcome: status})
    log.info("daily vocabulary scan checkpointed", {
      date,
      status,
      transcripts: all.length,
      users: byUser.size,
      failedUsers: failedUsers.length,
    })
    return status
  }

  async query(
    options: {
      date?: string
      user?: string
      status?: StoredVocabularyBatch["status"]
      limit?: number
    } = {},
  ): Promise<StoredVocabularyBatch[]> {
    const keys = (await this.deps.store.list(batchPrefix(options.date))).sort()
    const requestedLimit = options.limit ?? 100
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 1000)) : 100
    const records: StoredVocabularyBatch[] = []
    for (const key of keys) {
      const parsed = safeJson(await this.deps.store.get(key)) as StoredVocabularyBatch | null
      if (!parsed?.batch || parsed.v !== 1) continue
      if (options.user && parsed.transcriptUser !== options.user) continue
      if (options.status && parsed.status !== options.status) continue
      records.push(parsed)
    }
    return records.slice(-limit)
  }

  private async scanUser(
    date: string,
    user: string,
    entries: TranscriptEntry[],
    now: number,
  ): Promise<StoredVocabularyBatch> {
    const chunks = promptChunks(entries)
    const corpus = entries.map((entry) => entry.text).join("\n")
    const proposals: ProposedCandidate[] = []
    for (let index = 0; index < chunks.length; index++) {
      const result = await this.generate({
        system: SCAN_SYSTEM,
        user: `China-local date: ${date}\nTranscript chunk ${index + 1} of ${chunks.length}, oldest first:\n${chunks[index]}`,
        maxOutputTokens: 16_384,
        responseSchema: SCAN_SCHEMA,
        operation: "daily_vocabulary_scan",
        model: resolveAnalystModel(),
        thinkingLevel: "medium",
        provider: resolveAnalystProvider(),
      })
      proposals.push(...sanitizeProposals(safeJson(result.text), corpus))
    }

    const sessions = inferSessions(entries, date)
    const candidates = materializeCandidates(mergeProposals(proposals), sessions)
    const sorted = sessions.map(({entry}) => entry).sort((a, b) => a.at - b.at)
    const batch: VocabularyBatch = {
      schemaVersion: VOCABULARY_BATCH_SCHEMA_VERSION,
      source: "linklingo",
      batchId: stableBatchId(user, date),
      localDate: date,
      timezone: "Asia/Shanghai",
      generatedAt: new Date(now).toISOString(),
      transcriptStartAt: new Date(sorted[0]!.at).toISOString(),
      transcriptEndAt: new Date(sorted[sorted.length - 1]!.at).toISOString(),
      transcriptCount: sorted.length,
      inferredSessionCount: new Set(sessions.map((entry) => entry.sessionId)).size,
      candidates,
    }
    metrics.increment("vocabulary_candidates_total", {}, candidates.length)
    return {
      v: 1,
      transcriptUser: user,
      status: candidates.length ? "ready" : "complete",
      batch,
      deliveryAttempts: 0,
      lastDeliveryError: null,
      deliveredAt: null,
    }
  }

  private async retryDeliveries(date: string, now: number): Promise<void> {
    for (const stored of await this.query({date, status: "ready", limit: 1000})) {
      await this.deliver(stored, now).catch((error) =>
        log.warn("vocabulary delivery retry failed", {date, user: stored.transcriptUser, error: String(error)}),
      )
    }
  }

  private async deliver(stored: StoredVocabularyBatch, now: number): Promise<void> {
    if (stored.status !== "ready" || stored.batch.candidates.length === 0) return
    stored.deliveryAttempts++
    await this.saveBatch(stored)
    const result = await this.deps.delivery.deliverVocabularyBatch(stored.transcriptUser, stored.batch)
    if (result.outcome === "accepted" || result.outcome === "duplicate") {
      stored.status = "delivered"
      stored.deliveredAt = new Date(now).toISOString()
      stored.lastDeliveryError = null
      metrics.increment("vocabulary_deliveries_total", {outcome: result.outcome})
    } else {
      stored.lastDeliveryError = result.error ?? result.outcome
      metrics.increment("vocabulary_deliveries_total", {outcome: result.outcome})
    }
    await this.saveBatch(stored)
  }

  private async loadBatch(date: string, user: string): Promise<StoredVocabularyBatch | null> {
    const parsed = safeJson(await this.deps.store.get(batchKey(date, user))) as StoredVocabularyBatch | null
    return parsed?.v === 1 && parsed.transcriptUser === user ? parsed : null
  }

  private async saveBatch(stored: StoredVocabularyBatch): Promise<void> {
    await this.deps.store.put(batchKey(stored.batch.localDate, stored.transcriptUser), JSON.stringify(stored))
  }
}
