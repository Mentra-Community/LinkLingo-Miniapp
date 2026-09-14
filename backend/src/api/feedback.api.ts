import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {analyseFeedback} from "../services/feedback.service"
import {LlmServiceError} from "../services/gemini"
import type {FeedbackRequest} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("feedback.api")

export const feedbackApi = new Hono<{Variables: MentraAuthVariables}>()

feedbackApi.use("*", mentraAuthMiddleware())

/**
 * POST /api/feedback — the learner flags a problem; the analyst model answers.
 * Deliberately slow (a reasoning model with the last ten minutes of tape), so
 * the phone treats this as a request measured in seconds.
 */
feedbackApi.post("/", async (c) => {
  let body: FeedbackRequest
  try {
    body = (await c.req.json()) as FeedbackRequest
  } catch (error) {
    metrics.increment("feedback_outcomes_total", {outcome: "bad_request"})
    log.warn("malformed feedback body", {error})
    return c.json({error: "Invalid JSON body"}, 400)
  }

  if (!body.note || !body.note.trim()) {
    metrics.increment("feedback_outcomes_total", {outcome: "empty"})
    return c.json({error: "note is required"}, 400)
  }
  if (!body.settings || typeof body.settings.inputLanguage !== "string") {
    metrics.increment("feedback_outcomes_total", {outcome: "bad_request"})
    return c.json({error: "settings are required"}, 400)
  }

  const normalized: FeedbackRequest = {
    note: body.note,
    settings: body.settings,
    recentUtterances: Array.isArray(body.recentUtterances) ? body.recentUtterances.slice(-20) : [],
    shownWords: Array.isArray(body.shownWords) ? body.shownWords.slice(-6) : [],
    recentWords: Array.isArray(body.recentWords) ? body.recentWords.slice(-12) : [],
    caption: typeof body.caption === "string" ? body.caption.slice(0, 600) : "",
    translation: typeof body.translation === "string" ? body.translation.slice(0, 600) : "",
    original: typeof body.original === "string" ? body.original.slice(0, 600) : "",
  }

  try {
    const analysis = await analyseFeedback(normalized)
    return c.json(analysis)
  } catch (error) {
    if (error instanceof LlmServiceError) {
      metrics.increment("feedback_outcomes_total", {outcome: `llm_${error.status}`})
      log.error("analyst call failed", {status: error.status, upstream: error.upstreamStatus, error})
      return c.json({error: error.message}, error.status)
    }
    metrics.increment("feedback_outcomes_total", {outcome: "error"})
    log.error("feedback analysis failed", {error})
    return c.json({error: "Analysis failed"}, 500)
  }
})
