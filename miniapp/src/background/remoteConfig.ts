import type {MiniappSession} from "@mentra/miniapp/background"

import type {AppConfig} from "../shared/blocks"
import {DEFAULT_CONFIG} from "../shared/defaultConfig"
import {createLogger, diagnostics} from "./observability"

const log = createLogger("config")

const KEY = "linklingo:config"
/** A config older than this is refetched when the WebView opens, not only at session start. */
export const CONFIG_STALE_MS = 10 * 60_000

/**
 * Accepts the server's config only if its shape is usable. A broken deploy
 * must not blank the settings card, so anything malformed is dropped and the
 * last good copy stays.
 */
export function validConfig(raw: unknown): AppConfig | null {
  const c = raw as Partial<AppConfig> | null
  if (!c || typeof c !== "object") return null
  if (typeof c.revision !== "string" || !Array.isArray(c.settings) || !Array.isArray(c.screens)) return null
  if (!c.tunables || typeof c.tunables !== "object") return null
  const screens = c.screens.filter(
    (s): s is AppConfig["screens"][number] =>
      !!s && typeof s.id === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(s.id) && typeof s.title === "string",
  )
  return {
    kit: typeof c.kit === "number" ? c.kit : 1,
    revision: c.revision,
    tunables: c.tunables,
    settings: c.settings,
    screens,
    prefDefaults: c.prefDefaults && typeof c.prefDefaults === "object" ? c.prefDefaults : {},
  }
}

export async function loadCachedConfig(session: MiniappSession): Promise<AppConfig> {
  try {
    const raw = await session.storage.get(KEY)
    const cached = raw ? validConfig(JSON.parse(raw)) : null
    if (cached) return cached
  } catch (err) {
    diagnostics.increment("config.cache_unreadable")
    log.warn("cached config unreadable; using the bundled default", {error: err as Error})
  }
  return DEFAULT_CONFIG
}

export async function saveConfig(session: MiniappSession, config: AppConfig): Promise<void> {
  try {
    await session.storage.set(KEY, JSON.stringify(config))
  } catch (err) {
    diagnostics.increment("config.save_failures")
    log.warn("could not cache config", {error: err as Error})
  }
}
