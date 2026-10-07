import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {VIEWS} from "../services/views"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("views.api")

export const viewsApi = new Hono<{Variables: MentraAuthVariables}>()

viewsApi.use("*", mentraAuthMiddleware())

/** GET /api/views/:screen — a screen as blocks for the phone to draw. */
viewsApi.get("/:screen", async (c) => {
  const screen = c.req.param("screen")
  const build = VIEWS[screen]
  if (!build) return c.json({error: "unknown screen"}, 404)
  const started = Date.now()
  try {
    const view = await build(c)
    if (view instanceof Response) return view
    metrics.increment("views_total", {screen, outcome: "ok"})
    metrics.observe("views_duration", Date.now() - started, {screen})
    return c.json(view)
  } catch (error) {
    metrics.increment("views_total", {screen, outcome: "error"})
    log.error("view failed", {screen, error})
    return c.json({error: "View unavailable"}, 500)
  }
})
