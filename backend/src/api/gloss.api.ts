import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {glossService, LlmServiceError} from "../services/gloss.service"
import type {GlossRequest} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("gloss.api")

export const glossApi = new Hono<{Variables: MentraAuthVariables}>()

glossApi.use("*", mentraAuthMiddleware())

glossApi.post("/", async (c) => {
  let body: GlossRequest
  try {
    body = (await c.req.json()) as GlossRequest
  } catch (error) {
    metrics.increment("gloss_outcomes_total", {outcome: "bad_request"})
    log.warn("malformed gloss request body", {error})
    return c.json({error: "Invalid JSON body", words: []}, 400)
  }

  try {
    return c.json(await glossService.gloss(body))
  } catch (error) {
    if (error instanceof LlmServiceError) {
      metrics.increment("gloss_outcomes_total", {outcome: "llm_error"})
      log.error("gloss failed upstream", {
        status: error.status,
        upstreamStatus: error.upstreamStatus,
        reason: error.message,
      })
      return c.json({error: error.message, words: []}, error.status)
    }
    metrics.increment("gloss_outcomes_total", {outcome: "internal_error"})
    log.error("gloss failed unexpectedly", {
      error,
      stack: error instanceof Error ? error.stack : undefined,
    })
    const message = error instanceof Error ? error.message : "Unknown error"
    return c.json({error: message, words: []}, 500)
  }
})
