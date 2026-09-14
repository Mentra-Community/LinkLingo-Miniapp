import {Hono} from "hono"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {formatReviewEntry, reviewLog, type ReviewOperation, type ReviewQuery} from "../services/review-log"
import {formatTranscriptEntry, transcriptLog, type TranscriptQuery} from "../services/transcript-log"
import type {TranscriptDisposition} from "../shared-types"

const log = createLogger("review.api")

/**
 * Operator-only. Entries carry verbatim conversation transcripts, so this is
 * gated by a shared secret rather than a Mentra user token: a user token would
 * identify a learner, not authorise reading everyone's speech. With no token
 * configured the routes do not exist.
 */
export function reviewToken(): string | undefined {
  return process.env.LINKLINGO_REVIEW_TOKEN || undefined
}

export const reviewApi = new Hono()

reviewApi.use("*", async (c, next) => {
  const expected = reviewToken()
  if (!expected) {
    metrics.increment("review_requests_total", {outcome: "disabled"})
    return c.json({error: "Not found"}, 404)
  }
  const header = c.req.header("Authorization") ?? ""
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : ""
  if (!presented || !constantTimeEqual(presented, expected)) {
    metrics.increment("review_requests_total", {outcome: "rejected"})
    log.warn("review request rejected", {hasHeader: header.length > 0})
    return c.json({error: "invalid review token"}, 401)
  }
  metrics.increment("review_requests_total", {outcome: "ok"})
  await next()
})

/**
 * `since`/`until` accept epoch milliseconds, an ISO timestamp, or a relative
 * window like `24h`, `90m`, `7d` measured back from now.
 */
export function parseTime(raw: string | undefined, now = Date.now()): number | undefined {
  if (!raw) return undefined
  const relative = /^(\d+)([smhd])$/.exec(raw.trim())
  if (relative) {
    const unit = {s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000}[relative[2] as "s" | "m" | "h" | "d"]
    return now - Number(relative[1]) * unit
  }
  if (/^\d+$/.test(raw)) return Number(raw)
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

reviewApi.get("/entries", (c) => {
  const op = c.req.query("op")
  if (op && op !== "gloss" && op !== "upgrade") {
    return c.json({error: "op must be gloss or upgrade"}, 400)
  }
  const query: ReviewQuery = {
    op: op as ReviewOperation | undefined,
    since: parseTime(c.req.query("since")),
    until: parseTime(c.req.query("until")),
    user: c.req.query("user") || undefined,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  }
  const entries = reviewLog.list(query)
  if (c.req.query("format") === "text") {
    return c.text(entries.map(formatReviewEntry).join("\n\n") + (entries.length ? "\n" : ""))
  }
  return c.json({count: entries.length, entries})
})

reviewApi.get("/transcripts", (c) => {
  const disposition = c.req.query("disposition") as TranscriptDisposition | undefined
  const query: TranscriptQuery = {
    since: parseTime(c.req.query("since")),
    until: parseTime(c.req.query("until")),
    user: c.req.query("user") || undefined,
    disposition,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  }
  const entries = transcriptLog.list(query)
  if (c.req.query("format") === "text") {
    return c.text(entries.map(formatTranscriptEntry).join("\n\n") + (entries.length ? "\n" : ""))
  }
  return c.json({count: entries.length, entries})
})

reviewApi.get("/stats", (c) => c.json({review: reviewLog.stats(), transcripts: transcriptLog.stats()}))

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
