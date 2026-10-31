import {Hono, type Context} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"
import {z} from "zod"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {getLearningService, identityOf, phoneStatuses} from "../services/learning-runtime"
import {PairError, configProblem, userKeyFor} from "../services/learning-outbox"
import {LEARNING_SCHEMA_VERSION} from "../vendor/mandarin-contract"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("learning.api")

type Env = {Variables: MentraAuthVariables & {mentraKeyring?: string}}

export const learningApi = new Hono<Env>()

learningApi.use("*", mentraAuthMiddleware())

const MAX_BODY_BYTES = 512 * 1024

async function readJson(c: Context<Env>): Promise<unknown> {
  const length = Number(c.req.header("content-length") ?? 0)
  if (length > MAX_BODY_BYTES) return undefined
  return c.req.json().catch(() => null)
}

learningApi.get("/status", async (c) => {
  const service = getLearningService()
  if (!service) {
    return c.json({
      enabled: false,
      problem: "Learning capture is not enabled on this server.",
      connected: false,
      label: null,
      environment: null,
      lastAcceptedAt: null,
      pendingServerEvents: 0,
      lastError: null,
    })
  }
  const status = await service.status(identityOf(c))
  return c.json({...status, phone: phoneStatuses.get(userKeyFor(identityOf(c))) ?? null})
})

const PairBody = z.object({secret: z.string().trim().min(20).max(200)})

learningApi.post("/pair", async (c) => {
  const service = getLearningService()
  if (!service) return c.json({error: "disabled", message: "Learning capture is not enabled on this server."}, 403)
  const body = PairBody.safeParse(await readJson(c))
  if (!body.success)
    return c.json({error: "bad_request", message: "Paste the pairing code from the Mandarin app."}, 400)
  try {
    const paired = await service.pair(identityOf(c), body.data.secret)
    return c.json({connected: true, ...paired})
  } catch (error) {
    if (error instanceof PairError) {
      const status = error.kind === "invalid" ? 400 : error.kind === "not_configured" ? 403 : 502
      return c.json({error: error.kind === "invalid" ? "pairing_invalid" : error.kind, message: error.message}, status)
    }
    log.error("pairing failed", {error: String(error)})
    return c.json({error: "unavailable", message: "Pairing failed. Try again."}, 502)
  }
})

const EventsBody = z.object({
  schemaVersion: z.literal(LEARNING_SCHEMA_VERSION),
  events: z.array(z.unknown()).min(1).max(100),
})

learningApi.post("/events", async (c) => {
  const service = getLearningService()
  if (!service || configProblem(service.config)) {
    return c.json({error: "disabled", message: "Learning capture is not enabled on this server."}, 403)
  }
  const raw = await readJson(c)
  if (raw === undefined) return c.json({error: "bad_request", message: "Request is too large."}, 413)
  const body = EventsBody.safeParse(raw)
  if (!body.success) return c.json({error: "bad_request", message: "Send schemaVersion 1 and 1-100 events."}, 400)

  const identity = identityOf(c)
  const userKey = userKeyFor(identity)
  const status = await service.status(identity)
  if (!status.connected) return c.json({error: "not_connected", message: "Pair with the Mandarin app first."}, 403)

  try {
    const {accepted, rejected} = await service.enqueue(userKey, body.data.events)
    // Acknowledged only now: every accepted event is in durable storage.
    if (accepted.length) void service.drain(userKey).catch(() => undefined)
    return c.json({schemaVersion: LEARNING_SCHEMA_VERSION, accepted, rejected, connected: true})
  } catch (error) {
    metrics.increment("learning_events_total", {outcome: "storage_error"})
    log.error("outbox write failed", {error: String(error)})
    return c.json({error: "storage_unavailable", message: "Could not store the events. Try again."}, 503)
  }
})

learningApi.post("/revoke", async (c) => {
  const service = getLearningService()
  if (!service) return c.json({ok: true})
  await service.revoke(userKeyFor(identityOf(c)))
  return c.json({ok: true})
})

const PhoneBody = z.object({
  state: z.string().max(40),
  pending: z.number().int().nonnegative(),
  /** The phone sends its gap records; only the count matters here. A bare number is accepted too. */
  gaps: z.union([z.number().int().nonnegative(), z.array(z.unknown()).max(1000)]).default(0),
  quarantined: z.number().int().nonnegative().optional(),
  lastError: z.string().max(300).nullable().default(null),
})

/** Best-effort phone-side state so the status screen can show a pending count the server cannot see. */
learningApi.post("/phone-status", async (c) => {
  const body = PhoneBody.safeParse(await readJson(c))
  if (!body.success) return c.json({error: "bad_request"}, 400)
  const {gaps, quarantined: _quarantined, ...rest} = body.data
  phoneStatuses.set(userKeyFor(identityOf(c)), {
    ...rest,
    gaps: Array.isArray(gaps) ? gaps.length : gaps,
    at: new Date().toISOString(),
  })
  return c.body(null, 204)
})
