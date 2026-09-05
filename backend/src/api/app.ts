import {Hono} from "hono"
import {cors} from "hono/cors"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {dictionaryDiagnostics} from "../services/frequency"
import {apiKeyFingerprint, resolveApiKeySource} from "../services/gemini"
import {glossService} from "../services/gloss.service"
import {glossApi} from "./gloss.api"
import {requestObservability} from "./observability"
import {upgradeApi} from "./upgrade.api"

const log = createLogger("app")

export function createApp(): Hono {
  const app = new Hono()

  app.use("*", requestObservability)

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    }),
  )

  app.onError((error, c) => {
    log.error("unhandled error", {path: c.req.path, error, stack: error.stack})
    return c.json({error: "Internal error"}, 500)
  })

  app.notFound((c) => {
    log.warn("route not found", {method: c.req.method, path: c.req.path})
    return c.json({error: "Not found"}, 404)
  })

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      service: "linklingo-miniapp-backend",
      package: process.env.PACKAGE_NAME ?? "com.mentra.link",
      model: glossService.model,
      llmKeySource: resolveApiKeySource() ?? null,
      llmKeyFingerprint: apiKeyFingerprint() ?? null,
      uptimeSeconds: metrics.snapshot().uptimeSeconds,
    }),
  )

  /**
   * Operational snapshot. Deliberately unauthenticated like /healthz: it holds
   * counters and latencies only, never transcripts or user identifiers.
   */
  app.get("/metrics", (c) =>
    c.json({
      service: "linklingo-miniapp-backend",
      model: glossService.model,
      llmKeyFingerprint: apiKeyFingerprint() ?? null,
      dictionaries: dictionaryDiagnostics(),
      ...metrics.snapshot(),
    }),
  )

  app.route("/api/gloss", glossApi)
  app.route("/api/upgrade", upgradeApi)

  return app
}
