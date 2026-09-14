/**
 * Transcript tape: every final utterance the glasses heard, kept ~24h so a
 * reviewer can walk the day and decide what should have been glossed.
 *
 * This is not the model-output log. That one only sees speech that reached
 * Gemini. This one also keeps the skips — English in a Chinese session,
 * fragments under the length floor, cooldown drops — and annotates each
 * line with the frequency candidates the pipeline would have offered.
 */

import {appendFileSync} from "node:fs"

import {currentRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {TranscriptDisposition, TranscriptRequest} from "../shared-types"
import {candidateWords, knownRankFor} from "./frequency"
import {digest} from "./review-log"

const log = createLogger("transcript")

const DEFAULT_RETENTION_HOURS = 24
const DEFAULT_MAX_ENTRIES = 4000

export interface TranscriptEntry {
  id: string
  at: number
  requestId?: string
  user?: string
  text: string
  detectedLanguage?: string
  inputLanguage: string
  outputLanguage: string
  proficiency: number
  knownRank: number
  mode: string
  disposition: TranscriptDisposition
  /** Words the frequency filter would have sent to the model, rarest first. */
  wouldGloss: string[]
}

export interface TranscriptQuery {
  since?: number
  until?: number
  user?: string
  disposition?: TranscriptDisposition
  limit?: number
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export class TranscriptLog {
  private entries: TranscriptEntry[] = []
  private seq = 0

  constructor(
    private readonly retentionMs = envNumber("LINKLINGO_REVIEW_RETENTION_HOURS", DEFAULT_RETENTION_HOURS) * 3_600_000,
    private readonly maxEntries = envNumber("LINKLINGO_TRANSCRIPT_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
    private readonly file: string | null = process.env.LINKLINGO_TRANSCRIPT_FILE || null,
  ) {}

  record(input: TranscriptRequest, now = Date.now()): TranscriptEntry {
    const request = currentRequestContext()
    const proficiency = Number.isFinite(input.fluencyLevel) ? input.fluencyLevel : 50
    const knownRank = knownRankFor(proficiency)
    const text = (input.text ?? "").trim()
    const wouldGloss =
      text && input.disposition !== "skipped_language" && input.disposition !== "translation_mode"
        ? candidateWords(text, input.inputLanguage, [], knownRank, input.outputLanguage).map((c) => `${c.word}:${c.rank}`)
        : []

    const entry: TranscriptEntry = {
      id: `${now.toString(36)}-t${(this.seq++).toString(36)}`,
      at: now,
      requestId: request?.requestId,
      user: request?.userId ? digest(request.userId) : undefined,
      text,
      detectedLanguage: input.detectedLanguage,
      inputLanguage: input.inputLanguage,
      outputLanguage: input.outputLanguage,
      proficiency,
      knownRank,
      mode: input.mode,
      disposition: input.disposition,
      wouldGloss,
    }
    this.entries.push(entry)
    this.prune(now)
    metrics.increment("transcript_entries_total", {disposition: entry.disposition})
    if (this.file) this.append(entry)
    return entry
  }

  list(query: TranscriptQuery = {}, now = Date.now()): TranscriptEntry[] {
    this.prune(now)
    const limit = Math.max(1, Math.min(query.limit ?? 500, this.maxEntries))
    const matched = this.entries.filter(
      (e) =>
        (query.since == null || e.at >= query.since) &&
        (query.until == null || e.at <= query.until) &&
        (!query.user || e.user === query.user) &&
        (!query.disposition || e.disposition === query.disposition),
    )
    return matched.slice(-limit)
  }

  stats(now = Date.now()): {
    entries: number
    oldestAt: number | null
    newestAt: number | null
    byDisposition: Record<string, number>
    withCandidates: number
  } {
    this.prune(now)
    const byDisposition: Record<string, number> = {}
    let withCandidates = 0
    for (const entry of this.entries) {
      byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1
      if (entry.wouldGloss.length > 0) withCandidates += 1
    }
    return {
      entries: this.entries.length,
      oldestAt: this.entries[0]?.at ?? null,
      newestAt: this.entries[this.entries.length - 1]?.at ?? null,
      byDisposition,
      withCandidates,
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

  private append(entry: TranscriptEntry): void {
    try {
      appendFileSync(this.file!, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      metrics.increment("transcript_file_write_failures_total")
      log.warn("transcript file append failed", {file: this.file, error})
    }
  }
}

export function formatTranscriptEntry(entry: TranscriptEntry): string {
  const when = new Date(entry.at).toISOString().replace("T", " ").slice(0, 19)
  const asr = entry.detectedLanguage ? ` asr=${entry.detectedLanguage}` : ""
  const lines = [
    `[${when}] ${entry.inputLanguage}→${entry.outputLanguage} ${entry.disposition} p=${entry.proficiency}${asr}`,
    `  heard:      ${entry.text || "(empty)"}`,
    `  would gloss: ${entry.wouldGloss.join(", ") || "(none)"}`,
  ]
  return lines.join("\n")
}

export const transcriptLog = new TranscriptLog()
