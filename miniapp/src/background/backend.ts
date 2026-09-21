import type {MiniappSession} from "@mentra/miniapp/background"

import type {
  FeedbackAnalysis,
  GlossedWord,
  LinkLingoProfiling,
  ShadowInterimObservation,
  TranscriptDisposition,
} from "../shared/types"
import {glossTelemetry, type GlossAttempt} from "./glossTelemetry"
import {CLIENT_BUILD_ID, CLIENT_VERSION} from "./identity"
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

/** Beyond this the TLS connection is likely gone and worth re-opening early. */
const PRECONNECT_IDLE_MS = 20_000

/**
 * Opens the connection while the user is still speaking, so the gloss that
 * follows pays only the round trip and not the handshake. Unauthenticated and
 * bodyless on purpose: it must never be slower than the thing it is hiding.
 */
export function preconnect(force = false): void {
  const idle = glossTelemetry.msSinceBackendRequest()
  if (!force && idle != null && idle < PRECONNECT_IDLE_MS) return
  glossTelemetry.noteBackendRequest()
  diagnostics.increment("preconnect.attempts")
  void fetch(url("/ping"), {method: "GET"})
    .then(() => diagnostics.increment("preconnect.ok"))
    .catch(() => diagnostics.increment("preconnect.failed"))
}

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
  attempt: GlossAttempt,
): Promise<BackendResult<GlossApiResult>> {
  const started = Date.now()
  // Minted here rather than server-side: the backend adopts an incoming
  // X-Request-Id, so the tape entry and the phone's own timings share one key
  // instead of being matched up by timestamp afterwards.
  const {requestId, client} = glossTelemetry.begin(attempt, started)
  diagnostics.increment("gloss.requests")
  log.debug("gloss request", {
    requestId,
    contextChars: body.conversationContext.length,
    in: body.inputLanguage,
    out: body.outputLanguage,
    recentCount: body.recentWords.length,
    queueReason: attempt.queueReason,
    queueWaitMs: client.current.queueWaitMs,
  })
  try {
    const res = await session.auth.fetch(url("/api/gloss"), {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Request-Id": requestId},
      body: JSON.stringify({...body, client}),
    })
    const durationMs = Date.now() - started
    diagnostics.observe("gloss.roundTrip", durationMs)
    if (!res.ok) {
      glossTelemetry.noteResponse(requestId, durationMs, "error")
      const message = await describeFailure("gloss", res, durationMs)
      diagnostics.recordError(message)
      return {ok: false, message}
    }
    glossTelemetry.noteResponse(requestId, durationMs, "ok")
    const data = (await res.json()) as GlossApiResult
    const words = data.words ?? []
    diagnostics.increment("gloss.ok")
    diagnostics.increment("gloss.words", words.length)
    log.info("gloss ok", {
      requestId,
      durationMs,
      queueWaitMs: client.current.queueWaitMs,
      words: words.length,
      serverMs: data.profiling?.totalMs,
      modelMs: data.profiling?.llmMs ?? data.profiling?.geminiMs,
    })
    return {
      ok: true,
      data: {
        words,
        profiling: {...data.profiling, clientRoundTripMs: durationMs, requestId},
      },
    }
  } catch (err) {
    const durationMs = Date.now() - started
    glossTelemetry.noteResponse(requestId, durationMs, "error")
    diagnostics.increment("gloss.transport_error")
    diagnostics.recordError("Cannot reach LinkLingo backend")
    log.error("gloss transport failure", {requestId, durationMs, url: BACKEND_URL, error: err as Error})
    return {ok: false, message: "Cannot reach LinkLingo backend"}
  }
}

export function reportTranscript(
  session: MiniappSession,
  body: {
    text: string
    detectedLanguage?: string
    inputLanguage: string
    outputLanguage: string
    fluencyLevel: number
    mode: string
    disposition: TranscriptDisposition
    utteranceId?: string
    /** Shadow-interim results for utterances whose final has now landed. */
    shadowInterim?: ShadowInterimObservation[]
    /** Realised lead when this utterance was glossed from an interim. */
    asrLeadMs?: number
  },
): void {
  const started = Date.now()
  const payload = {...body, clientVersion: CLIENT_VERSION, clientBuildId: CLIENT_BUILD_ID}
  diagnostics.increment("transcript.reports")
  // Counts toward networkIdleMs: this POST warms the same TLS connection the
  // next gloss will use, so ignoring it would overstate how cold that gloss is.
  glossTelemetry.noteBackendRequest(started)
  void session.auth
    .fetch(url("/api/transcript"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    })
    .then((res) => {
      diagnostics.observe("transcript.roundTrip", Date.now() - started)
      if (!res.ok) {
        diagnostics.increment(`transcript.http_${res.status}`)
        log.debug("transcript report rejected", {status: res.status, disposition: body.disposition})
        return
      }
      diagnostics.increment("transcript.ok")
    })
    .catch((err) => {
      diagnostics.increment("transcript.transport_error")
      log.debug("transcript report failed", {error: err as Error})
    })
}

export interface FeedbackBody {
  note: string
  settings: {inputLanguage: string; outputLanguage: string; proficiency: number; mode: string}
  recentUtterances: Array<{text: string; at: number; language?: string}>
  shownWords: GlossedWord[]
  recentWords: GlossedWord[]
  caption: string
  translation: string
  original: string
}

/** The analyst model thinks for real, so this call is measured in seconds, not the gloss path's sub-second. */
export async function requestFeedback(
  session: MiniappSession,
  body: FeedbackBody,
): Promise<BackendResult<FeedbackAnalysis>> {
  const started = Date.now()
  diagnostics.increment("feedback.requests")
  try {
    const res = await session.auth.fetch(url("/api/feedback"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    const durationMs = Date.now() - started
    diagnostics.observe("feedback.roundTrip", durationMs)
    if (!res.ok) {
      const message = await describeFailure("feedback", res, durationMs)
      return {ok: false, message}
    }
    const data = (await res.json()) as FeedbackAnalysis
    diagnostics.increment("feedback.ok")
    log.info("feedback answered", {durationMs, model: data.model, answerChars: data.answer.length})
    return {ok: true, data}
  } catch (err) {
    diagnostics.increment("feedback.transport_error")
    log.error("feedback transport failure", {url: BACKEND_URL, error: err as Error})
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
  glossTelemetry.noteBackendRequest(started)
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
