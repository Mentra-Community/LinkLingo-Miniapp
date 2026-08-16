import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {glossService, LlmServiceError} from "../services/gloss.service"
import type {GlossRequest} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

export const glossApi = new Hono<{Variables: MentraAuthVariables}>()

glossApi.use("*", mentraAuthMiddleware())

glossApi.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as GlossRequest
    return c.json(await glossService.gloss(body))
  } catch (error) {
    if (error instanceof LlmServiceError) {
      return c.json({error: error.message, words: []}, error.status)
    }
    const message = error instanceof Error ? error.message : "Unknown error"
    return c.json({error: message, words: []}, 500)
  }
})
