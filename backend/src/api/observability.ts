import {createMiddleware} from "hono/factory"

import {annotateRequestContext, newRequestId, runWithRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"

const log = createLogger("http")

export const PREFS_HEADER = "x-linklingo-prefs"
const MAX_PREFS_CHARS = 2048
const MAX_PREFS = 40

/** Accepts only flat string/number/boolean maps; anything else is dropped rather than trusted. */
export function parsePrefs(raw: string | undefined): Record<string, string | number | boolean> | undefined {
  if (!raw || raw.length > MAX_PREFS_CHARS) return undefined
  try {
    const parsed = JSON.parse(decodeURIComponent(raw)) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const out: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(parsed).slice(0, MAX_PREFS)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) out[key] = value
      else if (typeof value === "string") out[key] = value.slice(0, 200)
    }
    return out
  } catch {
    return undefined
  }
}

/** Kubernetes probes hit these several times a minute; info-logging them drowns real traffic. */
const PROBE_PATHS = new Set(["/healthz", "/metrics"])

/**
 * Buckets a status code so metrics stay low-cardinality while still showing
 * whether failures are client- or server-side.
 */
function statusClass(status: number): string {
  if (status >= 500) return "5xx"
  if (status >= 400) return "4xx"
  if (status >= 300) return "3xx"
  return "2xx"
}

export const requestObservability = createMiddleware(async (c, next) => {
  const method = c.req.method
  const path = c.req.path
  const requestId = c.req.header("x-request-id") ?? newRequestId()
  const isProbe = PROBE_PATHS.has(path)
  const started = Date.now()

  const prefs = parsePrefs(c.req.header(PREFS_HEADER))
  await runWithRequestContext({requestId, route: `${method} ${path}`, prefs}, async () => {
    if (!isProbe) {
      log.info("request start", {method, path, ua: c.req.header("user-agent")})
    }

    try {
      await next()
    } catch (error) {
      const durationMs = Date.now() - started
      metrics.increment("http_requests_total", {path, status: "5xx"})
      metrics.increment("http_unhandled_errors_total", {path})
      metrics.observe("http_request_duration", durationMs, {path})
      log.error("request threw", {method, path, durationMs, error})
      throw error
    }

    const durationMs = Date.now() - started
    const status = c.res.status
    metrics.increment("http_requests_total", {path, status: statusClass(status)})
    metrics.observe("http_request_duration", durationMs, {path})

    if (isProbe) return
    const fields = {method, path, status, durationMs}
    if (status >= 500) log.error("request failed", fields)
    else if (status >= 400) log.warn("request rejected", fields)
    else log.info("request ok", fields)
  })

  c.header("x-request-id", requestId)
})

/** Records the authenticated user so every later log line in the request has it. */
export function noteAuthenticatedUser(userId: string | undefined): void {
  annotateRequestContext({userId})
}

/** JWKS verification can dominate a cold request; the tape needs it separated out. */
export function noteAuthDuration(authMs: number): void {
  annotateRequestContext({authMs})
}
