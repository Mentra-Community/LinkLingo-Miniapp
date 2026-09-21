/**
 * Holds the upstream LLM connection open during a conversation.
 *
 * An idle HTTPS connection gets torn down, and the next gloss then pays a
 * fresh handshake on top of its round trip. The review tape records
 * `llmIdleMs` per call, so the question this answers — does a cold upstream
 * cost measurably more than a warm one — is already measurable, and this loop
 * can be judged by whether the cold bucket collapses toward the warm one.
 *
 * Only runs while someone is actually talking: a pod with no traffic should
 * not be generating any either.
 */

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {lastLlmCallTimestamp, openRouterBaseUrl, resolveApiKey} from "./openrouter"

const log = createLogger("llm-keepalive")

/** Comfortably under the idle timeout of a typical edge proxy. */
const INTERVAL_MS = 45_000
/** After this long with no gloss, the session is over and the pod goes quiet. */
const ACTIVE_WINDOW_MS = 10 * 60_000
/** A probe that outlives this is not keeping anything warm. */
const TIMEOUT_MS = 5_000

let timer: ReturnType<typeof setInterval> | null = null

export function startLlmKeepalive(): void {
  if (timer) return
  if (!resolveApiKey()) {
    log.debug("not starting: no API key, so there is no upstream to keep warm")
    return
  }
  timer = setInterval(() => void probe(), INTERVAL_MS)
  // Never hold the process open on this alone.
  timer.unref?.()
  log.info("keep-warm loop started", {intervalMs: INTERVAL_MS, activeWindowMs: ACTIVE_WINDOW_MS})
}

export function stopLlmKeepalive(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

async function probe(): Promise<void> {
  const last = lastLlmCallTimestamp()
  if (last == null || Date.now() - last > ACTIVE_WINDOW_MS) return

  try {
    // HEAD on a public path: no tokens spent, no quota touched, same origin as
    // the completions endpoint so it reuses the same connection pool.
    const response = await fetch(`${openRouterBaseUrl()}/models`, {
      method: "HEAD",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    metrics.increment("llm_keepalive_total", {outcome: response.ok ? "ok" : "rejected"})
  } catch {
    // A failed probe means the next real call pays the handshake, which is
    // exactly the status quo. Not worth surfacing above debug.
    metrics.increment("llm_keepalive_total", {outcome: "error"})
  }
}
