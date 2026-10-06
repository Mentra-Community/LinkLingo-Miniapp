/**
 * Once a day per learner, the analyst model reads the last 24h of speech in
 * the language being learned and points out likely mistakes. It has to run
 * before the tape deletes that speech, and only its short findings survive
 * into the 90-day ledger. The glasses cannot tell the learner's voice from
 * anyone else's, so every finding is a guess about who said it.
 */

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {TranscriptDisposition} from "../shared-types"
import {generateJson, resolveAnalystModel, resolveAnalystProvider, resolveApiKey} from "./gemini"
import {historyStore, type HistoryStore, type ReviewItem} from "./history-store"
import {transcriptLog, type TranscriptEntry} from "./transcript-log"

const log = createLogger("daily-review")

const WINDOW_MS = 24 * 3_600_000
/** A review younger than this means the learner is done for the day. */
const REVIEW_EVERY_MS = 20 * 3_600_000
const LOOP_MS = 3_600_000
/**
 * Karpenter evicts the dev pod about every 30 minutes, so an hourly timer
 * alone would never fire. Check once shortly after boot, once the tape has
 * loaded; the ledger lookup keeps a new pod from reviewing the same day again.
 */
const FIRST_RUN_MS = 2 * 60_000
/** Fewer finals than this is not enough speech to say anything about. */
const MIN_UTTERANCES = 5
const MAX_UTTERANCES = 400
const MAX_ITEMS = 8
const MAX_SAID = 20
const MAX_BETTER = 40
const MAX_RULE = 140

/** Finals spoken in the input language; English fallbacks and translate mode are not the learner's attempt. */
const LEARNER_SPEECH = new Set<TranscriptDisposition>([
  "queued_gloss",
  "skipped_short",
  "skipped_duplicate",
  "skipped_cooldown",
  "skipped_no_candidates",
  "heard",
])

const REVIEW_SYSTEM = `You review a day of speech recorded by a language learner's smart glasses. The recognizer cannot tell speakers apart: the learner's own sentences are mixed with native speakers around them, and some lines are recognition errors.

Find mistakes the learner most plausibly made: sentences that are ungrammatical or clearly unnatural for a native speaker, wrong measure words, wrong word order, a wrong word choice. Ignore sentences that read like fluent native speech, which are most likely someone else. Ignore obvious recognition garbage, names and numbers.

For each mistake give:
- "said": the wrong fragment copied exactly from the transcript, at most 20 characters
- "better": the natural fix, at most 40 characters
- "rule": one plain-English sentence explaining the fix
- "confidence": "high" only when it is clearly an error and clearly a learner's sentence, "medium" when one of those is uncertain, otherwise "low"

At most 8 items, best first. Returning {"items":[]} is correct when nothing stands out.
Return JSON only: {"items":[{"said":"...","better":"...","rule":"...","confidence":"high"}]}`

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          said: {type: "string"},
          better: {type: "string"},
          rule: {type: "string"},
          confidence: {type: "string", enum: ["high", "medium", "low"]},
        },
        required: ["said", "better", "rule", "confidence"],
      },
    },
  },
  required: ["items"],
}

type Generate = (opts: Parameters<typeof generateJson>[0]) => Promise<{text: string}>

export interface DailyReviewDeps {
  history: HistoryStore
  transcripts: () => TranscriptEntry[]
  generate: Generate
  enabled: () => boolean
}

const defaultDeps: DailyReviewDeps = {
  history: historyStore,
  transcripts: () => transcriptLog.list({since: Date.now() - WINDOW_MS, limit: 4000}),
  generate: generateJson,
  enabled: () => Boolean(resolveApiKey()),
}

function clip(value: unknown, max: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return [...text].slice(0, max).join("")
}

export function sanitizeItems(raw: unknown): ReviewItem[] {
  const list = Array.isArray((raw as {items?: unknown})?.items) ? (raw as {items: unknown[]}).items : []
  const out: ReviewItem[] = []
  for (const item of list) {
    const value = item as Record<string, unknown>
    const said = clip(value.said, MAX_SAID)
    const better = clip(value.better, MAX_BETTER)
    if (!said || !better || said === better) continue
    const confidence = value.confidence === "high" || value.confidence === "medium" ? value.confidence : "low"
    out.push({said, better, rule: clip(value.rule, MAX_RULE), confidence})
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

export class DailyReviewer {
  /** Survives only the pod; the ledger is the durable record of a review having run. */
  private readonly lastRun = new Map<string, number>()
  private running = false

  constructor(private readonly deps: DailyReviewDeps = defaultDeps) {}

  /** Users with enough learner speech on the tape and no review in the last 20h. */
  async dueUsers(now = Date.now()): Promise<Map<string, TranscriptEntry[]>> {
    const byUser = new Map<string, TranscriptEntry[]>()
    for (const entry of this.deps.transcripts()) {
      if (!entry.user || !entry.text || entry.at < now - WINDOW_MS) continue
      if (!LEARNER_SPEECH.has(entry.disposition)) continue
      const list = byUser.get(entry.user) ?? []
      list.push(entry)
      byUser.set(entry.user, list)
    }
    for (const [user, entries] of byUser) {
      if (entries.length < MIN_UTTERANCES || (await this.reviewedRecently(user, now))) byUser.delete(user)
    }
    return byUser
  }

  async runOnce(now = Date.now()): Promise<number> {
    if (this.running || !this.deps.enabled()) return 0
    this.running = true
    let reviewed = 0
    try {
      for (const [user, entries] of await this.dueUsers(now)) {
        await this.review(user, entries, now)
        reviewed++
      }
    } finally {
      this.running = false
    }
    return reviewed
  }

  private async reviewedRecently(user: string, now: number): Promise<boolean> {
    const last = this.lastRun.get(user)
    if (last && now - last < REVIEW_EVERY_MS) return true
    const events = await this.deps.history.events(user, now - REVIEW_EVERY_MS, now, now)
    const found = events.some((e) => e.kind === "review")
    if (found) this.lastRun.set(user, now)
    return found
  }

  private async review(user: string, entries: TranscriptEntry[], now: number): Promise<void> {
    const language = entries[entries.length - 1]!.inputLanguage
    const lines = entries.slice(-MAX_UTTERANCES).map((e) => `${new Date(e.at).toISOString().slice(11, 16)} ${e.text}`)
    const started = Date.now()
    try {
      const result = await this.deps.generate({
        system: REVIEW_SYSTEM,
        user: `Language being learned: ${language}\nTranscript, oldest first:\n${lines.join("\n")}`,
        maxOutputTokens: 16_384,
        responseSchema: REVIEW_SCHEMA,
        operation: "daily_review",
        model: resolveAnalystModel(),
        thinkingLevel: "medium",
        provider: resolveAnalystProvider(),
      })
      const items = sanitizeItems(JSON.parse(result.text))
      // Recorded even when empty, so a clean day is not reviewed again an hour later.
      this.deps.history.record(user, {kind: "review", at: now, items})
      this.lastRun.set(user, now)
      metrics.increment("daily_reviews_total", {outcome: "ok"})
      log.info("daily review stored", {user, utterances: lines.length, items: items.length, ms: Date.now() - started})
    } catch (error) {
      metrics.increment("daily_reviews_total", {outcome: "error"})
      log.warn("daily review failed", {user, error})
    }
  }
}

export const dailyReviewer = new DailyReviewer()

let timer: ReturnType<typeof setInterval> | null = null
let firstRun: ReturnType<typeof setTimeout> | null = null

export function startDailyReviews(): void {
  if (timer) return
  firstRun = setTimeout(() => void dailyReviewer.runOnce(), FIRST_RUN_MS)
  firstRun.unref?.()
  timer = setInterval(() => void dailyReviewer.runOnce(), LOOP_MS)
  timer.unref?.()
}

export function stopDailyReviews(): void {
  if (firstRun) clearTimeout(firstRun)
  if (timer) clearInterval(timer)
  firstRun = null
  timer = null
}
