/**
 * Review log: every model call, what it was shown and what came back, kept
 * for about a day so the prompt can be tuned against real output rather than
 * against the eval corpus alone.
 *
 * Storage is an in-memory ring on the pod. That is deliberate: it needs no
 * infrastructure and a redeploy is the natural end of a review window, since a
 * new deploy usually means a new prompt. Set LINKLINGO_REVIEW_FILE to also
 * append every entry as JSONL for a durable local history; the review script
 * does the same on the laptop side with `--save`.
 */

import {createHash} from "node:crypto"
import {appendFileSync} from "node:fs"

import {currentRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"

const log = createLogger("review")

const DEFAULT_RETENTION_HOURS = 24
const DEFAULT_MAX_ENTRIES = 2000

export type ReviewOperation = "gloss" | "upgrade"

export interface ReviewPair {
  word: string
  translation: string
}

export interface ReviewRejection {
  word: string
  reason: string
}

export interface ReviewEntry {
  id: string
  /** Epoch milliseconds when the call finished. */
  at: number
  op: ReviewOperation
  requestId?: string
  /** Short one-way digest of the Mentra user id; enough to group a session. */
  user?: string
  model: string
  /** Digest of the system prompt in force, so output can be compared across prompt edits. */
  promptVersion: string
  inputLanguage: string
  outputLanguage: string
  proficiency: number
  knownRank: number
  /** The transcript window the model saw. */
  context: string
  /** `word:rank` list offered to the model (gloss only). */
  candidates?: string[]
  recent?: string[]
  outcome: string
  /** Verbatim model text, before any parsing or filtering. */
  raw?: string
  proposed?: ReviewPair[]
  accepted: ReviewPair[]
  rejected: ReviewRejection[]
  geminiMs?: number
  totalMs: number
  /** Phone-measured round trip of the previous call; see GlossRequest. */
  clientRoundTripMs?: number
}

export type ReviewEntryInput = Omit<ReviewEntry, "id" | "at" | "requestId" | "user">

export interface ReviewQuery {
  op?: ReviewOperation
  since?: number
  until?: number
  user?: string
  limit?: number
}

export interface ReviewStats {
  entries: number
  oldestAt: number | null
  newestAt: number | null
  retentionHours: number
  maxEntries: number
  byOutcome: Record<string, number>
  byRejectReason: Record<string, number>
  file: string | null
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Stable short digest of a prompt or identifier. */
export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 8)
}

export class ReviewLog {
  private entries: ReviewEntry[] = []
  private seq = 0

  constructor(
    private readonly retentionMs = envNumber("LINKLINGO_REVIEW_RETENTION_HOURS", DEFAULT_RETENTION_HOURS) * 3_600_000,
    private readonly maxEntries = envNumber("LINKLINGO_REVIEW_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
    private readonly file: string | null = process.env.LINKLINGO_REVIEW_FILE || null,
  ) {}

  record(input: ReviewEntryInput, now = Date.now()): ReviewEntry {
    const request = currentRequestContext()
    const entry: ReviewEntry = {
      id: `${now.toString(36)}-${(this.seq++).toString(36)}`,
      at: now,
      requestId: request?.requestId,
      user: request?.userId ? digest(request.userId) : undefined,
      ...input,
    }
    this.entries.push(entry)
    this.prune(now)
    metrics.increment("review_entries_total", {op: entry.op, outcome: entry.outcome})
    if (this.file) this.append(entry)
    return entry
  }

  list(query: ReviewQuery = {}, now = Date.now()): ReviewEntry[] {
    this.prune(now)
    const limit = Math.max(1, Math.min(query.limit ?? 200, this.maxEntries))
    const matched = this.entries.filter(
      (e) =>
        (!query.op || e.op === query.op) &&
        (query.since == null || e.at >= query.since) &&
        (query.until == null || e.at <= query.until) &&
        (!query.user || e.user === query.user),
    )
    return matched.slice(-limit)
  }

  stats(now = Date.now()): ReviewStats {
    this.prune(now)
    const byOutcome: Record<string, number> = {}
    const byRejectReason: Record<string, number> = {}
    for (const entry of this.entries) {
      byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1
      for (const r of entry.rejected) byRejectReason[r.reason] = (byRejectReason[r.reason] ?? 0) + 1
    }
    return {
      entries: this.entries.length,
      oldestAt: this.entries[0]?.at ?? null,
      newestAt: this.entries[this.entries.length - 1]?.at ?? null,
      retentionHours: this.retentionMs / 3_600_000,
      maxEntries: this.maxEntries,
      byOutcome,
      byRejectReason,
      file: this.file,
    }
  }

  clear(): void {
    this.entries = []
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs
    let start = 0
    while (start < this.entries.length && this.entries[start].at < cutoff) start++
    if (this.entries.length - start > this.maxEntries) start = this.entries.length - this.maxEntries
    if (start > 0) this.entries = this.entries.slice(start)
  }

  private append(entry: ReviewEntry): void {
    try {
      appendFileSync(this.file!, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      // A full or read-only disk must never take the gloss path down with it.
      metrics.increment("review_file_write_failures_total")
      log.warn("review log file append failed", {file: this.file, error})
    }
  }
}

/**
 * One entry as a reviewer reads it: what the learner heard, what the model was
 * offered, what it answered, and why any of it was dropped.
 */
export function formatReviewEntry(entry: ReviewEntry): string {
  const when = new Date(entry.at).toISOString().replace("T", " ").slice(0, 19)
  const head = `[${when}] ${entry.op} ${entry.inputLanguage}→${entry.outputLanguage} p=${entry.proficiency} known=${entry.knownRank} ${entry.outcome} ${entry.totalMs}ms`
  const lines = [head, `  heard:      ${entry.context || "(empty)"}`]
  if (entry.candidates) lines.push(`  candidates: ${entry.candidates.join(", ") || "(none)"}`)
  if (entry.raw != null) lines.push(`  model:      ${entry.raw.replace(/\s+/g, " ").trim()}`)
  lines.push(
    `  shown:      ${entry.accepted.map((p) => `${p.word} -> ${p.translation}`).join(" | ") || "(nothing)"}`,
  )
  if (entry.rejected.length > 0) {
    lines.push(`  dropped:    ${entry.rejected.map((r) => `${r.word} (${r.reason})`).join(", ")}`)
  }
  const meta = [entry.model, `prompt=${entry.promptVersion}`]
  if (entry.geminiMs != null) meta.push(`model=${entry.geminiMs}ms`)
  if (entry.clientRoundTripMs != null) meta.push(`phoneRtt=${entry.clientRoundTripMs}ms`)
  if (entry.user) meta.push(`user=${entry.user}`)
  if (entry.requestId) meta.push(`req=${entry.requestId}`)
  lines.push(`  ${meta.join("  ")}`)
  return lines.join("\n")
}

export const reviewLog = new ReviewLog()
