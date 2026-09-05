import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {LlmServiceError} from "../services/gemini"
import {upgradeService} from "../services/upgrade.service"
import type {UpgradeRequest} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

export const upgradeApi = new Hono<{Variables: MentraAuthVariables}>()

upgradeApi.use("*", mentraAuthMiddleware())

upgradeApi.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as UpgradeRequest
    return c.json(await upgradeService.upgrade(body))
  } catch (error) {
    if (error instanceof LlmServiceError) {
      console.error(`[upgrade] ${error.status}: ${error.message}`)
      return c.json({error: error.message}, error.status)
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    console.error(`[upgrade] 500: ${message}`, error instanceof Error ? error.stack : "")
    return c.json({error: message}, 500)
  }
})
