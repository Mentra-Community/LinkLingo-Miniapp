import {Hono} from "hono"
import {cors} from "hono/cors"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {dictionaryDiagnostics} from "../services/frequency"
import {apiKeyFingerprint, resolveApiKeySource} from "../services/gemini"
import {glossService} from "../services/gloss.service"
import {bundleApi, hostedBundleStatus} from "./bundle.api"
import {glossApi} from "./gloss.api"
import {requestObservability} from "./observability"
import {reviewApi} from "./review.api"
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

  app.get("/healthz", async (c) =>
    c.json({
      status: "ok",
      service: "linklingo-miniapp-backend",
      package: process.env.PACKAGE_NAME ?? "com.mentra.link",
      model: glossService.model,
      llmKeySource: resolveApiKeySource() ?? null,
      llmKeyFingerprint: apiKeyFingerprint() ?? null,
      uptimeSeconds: metrics.snapshot().uptimeSeconds,
      // Which miniapp build this pod hands to phones, and the backend origin
      // compiled into it. A bundle pointing at the wrong environment is
      // otherwise invisible until a user's glasses misbehave.
      miniapp: await hostedBundleStatus(),
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
  // Last ~24h of model input/output for prompt tuning. Only mounted in effect
  // when LINKLINGO_REVIEW_TOKEN is set; see `bun run review`.
  app.route("/api/review", reviewApi)
  // Base URL a phone installs from: Developer settings → Mini App Development
  // → Load from URL → `<origin>/miniapp`.
  app.route("/miniapp", bundleApi)

  return app
}
