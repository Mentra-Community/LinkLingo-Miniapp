import type {MiniappSession} from "@mentra/miniapp/background"

import type {GlossedWord, LinkLingoProfiling} from "../shared/types"

const BACKEND_URL = process.env.MENTRA_PUBLIC_LINKLINGO_BACKEND_URL || "http://localhost:3240"

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
async function describeFailure(label: string, res: Response): Promise<string> {
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
  console.warn(`[linklingo] ${label} ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`)
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
  try {
    const res = await session.auth.fetch(url("/api/gloss"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return {ok: false, message: await describeFailure("gloss", res)}
    }
    const data = (await res.json()) as GlossApiResult
    return {
      ok: true,
      data: {
        words: data.words ?? [],
        profiling: {...data.profiling, clientRoundTripMs: Date.now() - started},
      },
    }
  } catch (err) {
    console.warn("[linklingo] gloss failed", err)
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
  try {
    const res = await session.auth.fetch(url("/api/upgrade"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      return {ok: false, message: await describeFailure("upgrade", res)}
    }
    const data = (await res.json()) as UpgradeApiResult
    return {
      ok: true,
      data: {...data, profiling: {...data.profiling, clientRoundTripMs: Date.now() - started}},
    }
  } catch (err) {
    console.warn("[linklingo] upgrade failed", err)
    return {ok: false, message: "Cannot reach LinkLingo backend"}
  }
}
