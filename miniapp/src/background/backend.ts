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

function url(path: string): string {
  return `${BACKEND_URL.replace(/\/$/, "")}${path}`
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
): Promise<GlossApiResult | null> {
  const started = Date.now()
  try {
    const res = await session.auth.fetch(url("/api/gloss"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(`[linklingo] gloss ${res.status}`)
      return null
    }
    const data = (await res.json()) as GlossApiResult
    return {
      words: data.words ?? [],
      profiling: {...data.profiling, clientRoundTripMs: Date.now() - started},
    }
  } catch (err) {
    console.warn("[linklingo] gloss failed", err)
    return null
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
): Promise<UpgradeApiResult | null> {
  const started = Date.now()
  try {
    const res = await session.auth.fetch(url("/api/upgrade"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      console.warn(`[linklingo] upgrade ${res.status}`)
      return null
    }
    const data = (await res.json()) as UpgradeApiResult
    return {
      ...data,
      profiling: {...data.profiling, clientRoundTripMs: Date.now() - started},
    }
  } catch (err) {
    console.warn("[linklingo] upgrade failed", err)
    return null
  }
}
