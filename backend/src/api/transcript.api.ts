import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {transcriptLog} from "../services/transcript-log"
import type {TranscriptDisposition, TranscriptRequest} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("transcript.api")

const DISPOSITIONS = new Set<TranscriptDisposition>([
  "queued_gloss",
  "skipped_language",
  "skipped_short",
  "skipped_duplicate",
  "skipped_cooldown",
  "translation_mode",
  "heard",
])

export const transcriptApi = new Hono<{Variables: MentraAuthVariables}>()

transcriptApi.use("*", mentraAuthMiddleware())

transcriptApi.post("/", async (c) => {
  let body: TranscriptRequest
  try {
    body = (await c.req.json()) as TranscriptRequest
  } catch (error) {
    metrics.increment("transcript_outcomes_total", {outcome: "bad_request"})
    log.warn("malformed transcript body", {error})
    return c.json({error: "Invalid JSON body"}, 400)
  }

  const text = (body.text ?? "").trim()
  if (!text) {
    metrics.increment("transcript_outcomes_total", {outcome: "empty"})
    return c.json({error: "text is required"}, 400)
  }
  if (!DISPOSITIONS.has(body.disposition)) {
    metrics.increment("transcript_outcomes_total", {outcome: "bad_disposition"})
    return c.json({error: "invalid disposition"}, 400)
  }

  const entry = transcriptLog.record({...body, text})
  metrics.increment("transcript_outcomes_total", {outcome: "ok"})
  return c.json({ok: true, id: entry.id, wouldGloss: entry.wouldGloss})
})
