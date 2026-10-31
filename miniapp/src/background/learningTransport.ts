/**
 * HTTP delivery for the learning queue. Authenticated exactly like the other
 * backend calls (`session.auth.fetch` adds the Mentra bearer token), but kept
 * out of backend.ts so a learning outage can never touch gloss telemetry.
 *
 * Contract (backend lane):
 *   POST /api/learning/events        {schemaVersion:1, events:[LearningEvent]}
 *     200 {schemaVersion:1, accepted:string[], rejected:[{eventId,reason,permanent}], connected:true}
 *     401                              -> auth failure
 *     403 {error:"not_connected"}      -> not connected
 *     400/413/422                      -> the batch itself is refused (bisected by the queue)
 *     5xx / network / timeout / other  -> transient
 *   GET  /api/learning/status        {connected, enabled, label, environment, lastAcceptedAt, lastError}
 *   POST /api/learning/phone-status  {state, pending, gaps, quarantined, lastError}   (best effort)
 *
 * The bare background engine has no AbortController guarantee for fetch, so
 * time limits are a Promise.race; a timed-out request is simply abandoned and
 * the same eventIds are resent later.
 */

import type {LearningEvent} from "../shared/mandarin-contract"
import type {CaptureGap, CaptureState, RejectedEvent, SendResult} from "./learningCapture"
import {LEARNING_SCHEMA_VERSION} from "./learningCapture"

/** Same resolution as backend.ts (inlined at build time by build.ts). */
const BACKEND_URL = process.env.MENTRA_PUBLIC_LINKLINGO_BACKEND_URL || "http://localhost:3240"

export function learningUrl(path: string, base: string = BACKEND_URL): string {
  return `${base.replace(/\/$/, "")}${path}`
}

export interface LearningServerStatus {
  connected: boolean
  /** Server-side feature flag. */
  enabled: boolean
  label: string | null
  environment: string | null
  lastAcceptedAt: number | null
  lastError: string | null
}

export type StatusResult =
  {ok: true; status: LearningServerStatus} | {ok: false; kind: "auth" | "transient"; error: string}

export interface PhoneStatusBody {
  state: CaptureState
  pending: number
  gaps: CaptureGap[]
  quarantined: number
  lastError: string | null
}

/** Makes an authenticated request to a backend path. In production: `(path, init) => session.auth.fetch(learningUrl(path), init)`. */
export type AuthFetch = (path: string, init: RequestInit) => Promise<Response>

export interface LearningTransportOptions {
  authFetch: AuthFetch
  /** Per-request time limit. */
  timeoutMs?: number
}

export interface LearningTransport {
  send(events: LearningEvent[]): Promise<SendResult>
  fetchStatus(): Promise<StatusResult>
  /** Best effort; resolves false instead of throwing. */
  postPhoneStatus(body: PhoneStatusBody): Promise<boolean>
  /** Redeems the pairing code the learner pasted. The code only travels to the backend, never into a URL or a log. */
  pair(code: string): Promise<{ok: boolean; message: string}>
}

const DEFAULT_TIMEOUT_MS = 20_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The backend sends an ISO time; accept epoch milliseconds too. */
function toMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const parsed = Date.parse(v)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

/** Validates a 200 body; anything unexpected is transient so nothing is acked on a guess. */
export function parseIngestResponse(body: unknown): SendResult {
  const o = body as {schemaVersion?: unknown; accepted?: unknown; rejected?: unknown} | null
  if (!o || typeof o !== "object" || o.schemaVersion !== LEARNING_SCHEMA_VERSION || !Array.isArray(o.accepted)) {
    return {kind: "transient", error: "unexpected response shape"}
  }
  const accepted = o.accepted.filter((id): id is string => typeof id === "string")
  const rejected: RejectedEvent[] = []
  if (Array.isArray(o.rejected)) {
    for (const r of o.rejected as Array<Record<string, unknown>>) {
      if (!r || typeof r !== "object" || typeof r.eventId !== "string") continue
      rejected.push({
        eventId: r.eventId,
        reason: asString(r.reason) ?? "rejected",
        // The backend only rejects an event it can never accept (malformed); retrying it would never succeed.
        permanent: r.permanent !== false,
      })
    }
  }
  return {kind: "ok", accepted, rejected}
}

export function createLearningTransport(options: LearningTransportOptions): LearningTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  async function doSend(events: LearningEvent[]): Promise<SendResult> {
    const res = await options.authFetch("/api/learning/events", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({schemaVersion: LEARNING_SCHEMA_VERSION, events}),
    })
    if (res.status === 401) return {kind: "auth", error: "HTTP 401"}
    if (res.status === 403) {
      const body = (await readJson(res)) as {error?: unknown} | null
      if (body && body.error === "not_connected") return {kind: "not_connected", error: "HTTP 403 not_connected"}
      return {kind: "auth", error: `HTTP 403${body && typeof body.error === "string" ? ` ${body.error}` : ""}`}
    }
    if (res.ok) return parseIngestResponse(await readJson(res))
    if (res.status === 400 || res.status === 413 || res.status === 422) {
      return {kind: "batch_rejected", status: res.status, error: `HTTP ${res.status}`}
    }
    return {kind: "transient", error: `HTTP ${res.status}`}
  }

  return {
    async send(events) {
      try {
        return await withTimeout(doSend(events), timeoutMs)
      } catch (err) {
        return {kind: "transient", error: describe(err)}
      }
    },

    async fetchStatus() {
      try {
        return await withTimeout(
          (async (): Promise<StatusResult> => {
            const res = await options.authFetch("/api/learning/status", {method: "GET"})
            if (res.status === 401 || res.status === 403) return {ok: false, kind: "auth", error: `HTTP ${res.status}`}
            if (!res.ok) return {ok: false, kind: "transient", error: `HTTP ${res.status}`}
            const body = (await readJson(res)) as Record<string, unknown> | null
            if (!body || typeof body !== "object" || typeof body.connected !== "boolean") {
              return {ok: false, kind: "transient", error: "unexpected response shape"}
            }
            return {
              ok: true,
              status: {
                connected: body.connected,
                enabled: body.enabled !== false,
                label: asString(body.label),
                environment: asString(body.environment),
                lastAcceptedAt: toMillis(body.lastAcceptedAt),
                lastError: asString(body.lastError),
              },
            }
          })(),
          timeoutMs,
        )
      } catch (err) {
        return {ok: false, kind: "transient", error: describe(err)}
      }
    },

    async pair(code) {
      try {
        const res = await withTimeout(
          options.authFetch("/api/learning/pair", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({secret: code.trim()}),
          }),
          timeoutMs,
        )
        const body = (await readJson(res)) as {message?: unknown; label?: unknown} | null
        if (res.ok)
          return {
            ok: true,
            message: `Connected${typeof body?.label === "string" && body.label ? ` to ${body.label}` : ""}.`,
          }
        if (res.status === 401 || res.status === 403) {
          return {
            ok: false,
            message:
              typeof body?.message === "string"
                ? body.message
                : "Sign-in expired. Reopen LinkLingo from the Mentra app.",
          }
        }
        return {
          ok: false,
          message: typeof body?.message === "string" ? body.message : `Pairing failed (${res.status}). Try again.`,
        }
      } catch (err) {
        return {ok: false, message: `Could not reach LinkLingo (${describe(err)}). Try again.`}
      }
    },

    async postPhoneStatus(body) {
      try {
        const res = await withTimeout(
          options.authFetch("/api/learning/phone-status", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body),
          }),
          timeoutMs,
        )
        return res.ok
      } catch {
        return false
      }
    },
  }
}
