import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {LlmServiceError} from "../services/gemini"
import {upgradeService} from "../services/upgrade.service"
import type {UpgradeRequest} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("upgrade.api")

export const upgradeApi = new Hono<{Variables: MentraAuthVariables}>()

upgradeApi.use("*", mentraAuthMiddleware())

upgradeApi.post("/", async (c) => {
  let body: UpgradeRequest
  try {
    body = (await c.req.json()) as UpgradeRequest
  } catch (error) {
    metrics.increment("upgrade_outcomes_total", {outcome: "bad_request"})
    log.warn("malformed upgrade request body", {error})
    return c.json({error: "Invalid JSON body"}, 400)
  }

  try {
    return c.json(await upgradeService.upgrade(body))
  } catch (error) {
    if (error instanceof LlmServiceError) {
      metrics.increment("upgrade_outcomes_total", {outcome: "llm_error"})
      log.error("upgrade failed upstream", {
        status: error.status,
        upstreamStatus: error.upstreamStatus,
        reason: error.message,
      })
      return c.json({error: error.message}, error.status)
    }
    metrics.increment("upgrade_outcomes_total", {outcome: "internal_error"})
    log.error("upgrade failed unexpectedly", {
      error,
      stack: error instanceof Error ? error.stack : undefined,
    })
    const message = error instanceof Error ? error.message : "Unknown error"
    return c.json({error: message}, 500)
  }
})
