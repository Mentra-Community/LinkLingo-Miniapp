import type {MiniappSession} from "@mentra/miniapp/background"

import type {GlossedWord, LinkLingoProfiling} from "../shared/types"
import {createLogger, diagnostics} from "./observability"

const log = createLogger("api")

const BACKEND_URL = process.env.MENTRA_PUBLIC_LINKLINGO_BACKEND_URL || "http://localhost:3240"

log.info("backend target configured", {url: BACKEND_URL})

export interface GlossApiResult {
  words: GlossedWord[]
  profiling: LinkLingoProfiling
}

export interface UpgradeApiResult {
  word?: string
  meaning?: string
  profiling: LinkLingoProfiling
}

export type BackendResult<T> = {ok: true; data: T} | {ok: false; message: string}

function url(path: string): string {
  return `${BACKEND_URL.replace(/\/$/, "")}${path}`
}

/**
 * The backend reports why a call failed in the body. Surfacing that instead of
 * a bare status is the difference between "gloss 500" and knowing the LLM quota
 * is gone.
 */
async function describeFailure(label: string, res: Response, durationMs: number): Promise<string> {
  let detail = ""
  try {
    const text = await res.text()
    try {
      detail = (JSON.parse(text) as {error?: string}).error ?? text
    } catch {
      detail = text
    }
  } catch {
    detail = ""
  }

  diagnostics.increment(`${label}.http_${res.status}`)
  // The backend stamps x-request-id on every response, so a phone-side failure
  // can be matched to the exact server-side request in the Porter logs.
  log.warn(`${label} rejected`, {
    status: res.status,
    durationMs,
    requestId: res.headers.get("x-request-id") ?? undefined,
    detail: detail ? detail.slice(0, 300) : undefined,
  })

  if (res.status === 429) return "Translation quota exhausted"
  if (res.status === 503) return "Translation service unavailable"
  if (res.status === 401 || res.status === 403) return "Sign-in expired"
  return `${label} failed (${res.status})`
}

export async function requestGloss(
  session: MiniappSession,
  body: {
    conversationContext: string
    inputLanguage: string
    outputLanguage: string
    fluencyLevel: number
    recentWords: string[]
  },
): Promise<BackendResult<GlossApiResult>> {
  const started = Date.now()
  diagnostics.increment("gloss.requests")
  log.debug("gloss request", {
    contextChars: body.conversationContext.length,
    in: body.inputLanguage,
    out: body.outputLanguage,
    recentCount: body.recentWords.length,
  })
  try {
    const res = await session.auth.fetch(url("/api/gloss"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    const durationMs = Date.now() - started
    diagnostics.observe("gloss.roundTrip", durationMs)
    if (!res.ok) {
      const message = await describeFailure("gloss", res, durationMs)
      diagnostics.recordError(message)
      return {ok: false, message}
    }
    const data = (await res.json()) as GlossApiResult
    const words = data.words ?? []
    diagnostics.increment("gloss.ok")
    diagnostics.increment("gloss.words", words.length)
    log.info("gloss ok", {
      durationMs,
      words: words.length,
      serverMs: data.profiling?.totalMs,
      modelMs: data.profiling?.geminiMs,
      requestId: res.headers.get("x-request-id") ?? undefined,
    })
    return {
      ok: true,
      data: {
        words,
        profiling: {...data.profiling, clientRoundTripMs: durationMs},
      },
    }
  } catch (err) {
    const durationMs = Date.now() - started
    diagnostics.increment("gloss.transport_error")
    diagnostics.recordError("Cannot reach LinkLingo backend")
    log.error("gloss transport failure", {durationMs, url: BACKEND_URL, error: err as Error})
    return {ok: false, message: "Cannot reach LinkLingo backend"}
  }
}

export async function requestUpgrade(
  session: MiniappSession,
  body: {
    conversationContext: string
    inputLanguage: string
    outputLanguage: string
    fluencyLevel: number
    recentUpgrades: string[]
  },
): Promise<BackendResult<UpgradeApiResult>> {
  const started = Date.now()
  diagnostics.increment("upgrade.requests")
  try {
    const res = await session.auth.fetch(url("/api/upgrade"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    const durationMs = Date.now() - started
    diagnostics.observe("upgrade.roundTrip", durationMs)
    if (!res.ok) {
      const message = await describeFailure("upgrade", res, durationMs)
      diagnostics.recordError(message)
      return {ok: false, message}
    }
    const data = (await res.json()) as UpgradeApiResult
    diagnostics.increment(data.word ? "upgrade.suggested" : "upgrade.empty")
    log.info("upgrade ok", {
      durationMs,
      suggested: Boolean(data.word),
      serverMs: data.profiling?.totalMs,
      requestId: res.headers.get("x-request-id") ?? undefined,
    })
    return {
      ok: true,
      data: {...data, profiling: {...data.profiling, clientRoundTripMs: durationMs}},
    }
  } catch (err) {
    const durationMs = Date.now() - started
    diagnostics.increment("upgrade.transport_error")
    diagnostics.recordError("Cannot reach LinkLingo backend")
    log.error("upgrade transport failure", {durationMs, url: BACKEND_URL, error: err as Error})
    return {ok: false, message: "Cannot reach LinkLingo backend"}
  }
}
