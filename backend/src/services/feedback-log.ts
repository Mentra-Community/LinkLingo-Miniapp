/**
 * Feedback log: every time the learner flagged a problem from the WebView,
 * what they said, what the phone and the tape showed at that moment, and what
 * the analyst model concluded. Kept ~24h like the other logs so a reviewer can
 * turn the day's complaints into prompt and filter changes.
 */

import {appendFileSync} from "node:fs"

import {currentRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {FeedbackAnalysis, FeedbackRequest} from "../shared-types"
import {digest} from "./review-log"

const log = createLogger("feedback")

const DEFAULT_RETENTION_HOURS = 24
const DEFAULT_MAX_ENTRIES = 500

export interface FeedbackEntry {
  id: string
  at: number
  requestId?: string
  user?: string
  note: string
  /** What the phone sent: settings, last utterances, rows on the glasses. */
  snapshot: Omit<FeedbackRequest, "note">
  /** How much server-side tape the analyst was shown. */
  tape: {transcripts: number; glossCalls: number; windowMs: number}
  analysis: FeedbackAnalysis
}

export type FeedbackEntryInput = Omit<FeedbackEntry, "id" | "at" | "requestId" | "user">

export interface FeedbackQuery {
  since?: number
  until?: number
  user?: string
  limit?: number
}

export interface FeedbackStats {
  entries: number
  oldestAt: number | null
  newestAt: number | null
  retentionHours: number
  file: string | null
}

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export class FeedbackLog {
  private entries: FeedbackEntry[] = []
  private seq = 0

  constructor(
    private readonly retentionMs = envNumber("LINKLINGO_REVIEW_RETENTION_HOURS", DEFAULT_RETENTION_HOURS) * 3_600_000,
    private readonly maxEntries = envNumber("LINKLINGO_FEEDBACK_MAX_ENTRIES", DEFAULT_MAX_ENTRIES),
    private readonly file: string | null = process.env.LINKLINGO_FEEDBACK_FILE || null,
  ) {}

  record(input: FeedbackEntryInput, now = Date.now()): FeedbackEntry {
    const request = currentRequestContext()
    const entry: FeedbackEntry = {
      id: `${now.toString(36)}-${(this.seq++).toString(36)}`,
      at: now,
      requestId: request?.requestId,
      user: request?.userId ? digest(request.userId) : undefined,
      ...input,
    }
    this.entries.push(entry)
    this.prune(now)
    metrics.increment("feedback_entries_total")
    if (this.file) this.append(entry)
    return entry
  }

  list(query: FeedbackQuery = {}, now = Date.now()): FeedbackEntry[] {
    this.prune(now)
    const limit = Math.max(1, Math.min(query.limit ?? 100, this.maxEntries))
    const matched = this.entries.filter(
      (e) =>
        (query.since == null || e.at >= query.since) &&
        (query.until == null || e.at <= query.until) &&
        (!query.user || e.user === query.user),
    )
    return matched.slice(-limit)
  }

  stats(now = Date.now()): FeedbackStats {
    this.prune(now)
    return {
      entries: this.entries.length,
      oldestAt: this.entries[0]?.at ?? null,
      newestAt: this.entries[this.entries.length - 1]?.at ?? null,
      retentionHours: this.retentionMs / 3_600_000,
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

  private append(entry: FeedbackEntry): void {
    try {
      appendFileSync(this.file!, `${JSON.stringify(entry)}\n`)
    } catch (error) {
      metrics.increment("feedback_file_write_failures_total")
      log.warn("feedback log file append failed", {file: this.file, error})
    }
  }
}

/** One exchange as a reviewer reads it: what the user said, what was on screen, what the analyst answered. */
export function formatFeedbackEntry(entry: FeedbackEntry): string {
  const when = new Date(entry.at).toISOString().replace("T", " ").slice(0, 19)
  const s = entry.snapshot.settings
  const lines = [
    `[${when}] feedback ${s.inputLanguage}→${s.outputLanguage} p=${s.proficiency} ${s.mode} ${entry.analysis.totalMs}ms`,
    `  user said:  ${entry.note.replace(/\s+/g, " ").trim()}`,
    `  on glasses: ${entry.snapshot.shownWords.map((w) => `${w.word} -> ${w.translation}`).join(" | ") || "(no words)"}`,
  ]
  const recent = entry.snapshot.recentWords.filter((w) => !entry.snapshot.shownWords.some((s) => s.word === w.word))
  if (recent.length > 0) lines.push(`  earlier:    ${recent.map((w) => `${w.word} -> ${w.translation}`).join(" | ")}`)
  if (entry.snapshot.caption) lines.push(`  caption:    ${entry.snapshot.caption.replace(/\s+/g, " ").trim()}`)
  if (entry.snapshot.translation) lines.push(`  translated: ${entry.snapshot.translation.replace(/\s+/g, " ").trim()}`)
  const heard = entry.snapshot.recentUtterances.slice(-3).map((u) => u.text)
  if (heard.length > 0) lines.push(`  heard:      ${heard.join(" / ")}`)
  lines.push(`  analyst:    ${entry.analysis.answer.replace(/\s+/g, " ").trim()}`)
  const meta = [entry.analysis.model, `tape=${entry.tape.transcripts}t/${entry.tape.glossCalls}g`]
  if (entry.user) meta.push(`user=${entry.user}`)
  if (entry.requestId) meta.push(`req=${entry.requestId}`)
  lines.push(`  ${meta.join("  ")}`)
  return lines.join("\n")
}

export const feedbackLog = new FeedbackLog()
