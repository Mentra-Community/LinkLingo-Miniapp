import type {MiniappSession} from "@mentra/miniapp/background"

import type {SettingValue} from "../shared/blocks"
import {SETTABLE_KEYS, type SettableKey} from "../shared/serverContract"
import {
  DEFAULT_SETTINGS,
  HUD_CAPTION_LINES,
  REVERSE_KNOWN_RANK_LIMITS,
  SETTINGS_SCHEMA_VERSION,
  type LinkLingoMode,
  type LinkLingoSettings,
} from "../shared/types"
import {createLogger, diagnostics} from "./observability"

const log = createLogger("settings")

const KEY = "linklingo:settings"

export async function loadSettings(session: MiniappSession): Promise<LinkLingoSettings> {
  try {
    const raw = await session.storage.get(KEY)
    if (!raw) {
      log.info("no stored settings; using factory defaults", {
        source: DEFAULT_SETTINGS.sourceLanguage,
        target: DEFAULT_SETTINGS.targetLanguage,
      })
      return {...DEFAULT_SETTINGS}
    }
    const parsed = JSON.parse(raw) as Partial<LinkLingoSettings>
    const fromVersion = parsed.schemaVersion ?? 1
    const next = migrateSettings(parsed)
    if (fromVersion < SETTINGS_SCHEMA_VERSION) {
      diagnostics.increment("settings.migrations")
      log.info("migrated stored settings", {
        fromVersion,
        toVersion: SETTINGS_SCHEMA_VERSION,
        pairBefore: `${parsed.sourceLanguage ?? "?"}->${parsed.targetLanguage ?? "?"}`,
        pairAfter: `${next.sourceLanguage}->${next.targetLanguage}`,
      })
      await saveSettings(session, next)
    }
    return next
  } catch (err) {
    // Falling back to defaults silently would look like the app forgetting
    // every preference for no reason.
    diagnostics.increment("settings.load_failures")
    log.error("could not read stored settings; falling back to defaults", {error: err as Error})
    return {...DEFAULT_SETTINGS}
  }
}

export async function saveSettings(session: MiniappSession, settings: LinkLingoSettings): Promise<void> {
  await session.storage.set(KEY, JSON.stringify(settings))
}

export function normalizeSettings(settings: LinkLingoSettings): LinkLingoSettings {
  const modes: LinkLingoMode[] = ["gloss", "gloss-captions", "translation"]
  return {
    ...settings,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    sourceLanguage: settings.sourceLanguage || "zh",
    targetLanguage: settings.targetLanguage || "en",
    proficiency: clamp(settings.proficiency, 0, 100),
    mode: modes.includes(settings.mode) ? settings.mode : "gloss-captions",
    displayLines: clamp(settings.displayLines, 1, HUD_CAPTION_LINES),
    displayWidth: settings.displayWidth === 0 || settings.displayWidth === 2 ? settings.displayWidth : 1,
    reverseGloss: settings.reverseGloss !== false,
    reverseKnownRank: Number.isFinite(settings.reverseKnownRank)
      ? clamp(Math.round(settings.reverseKnownRank), REVERSE_KNOWN_RANK_LIMITS[0], REVERSE_KNOWN_RANK_LIMITS[1])
      : DEFAULT_SETTINGS.reverseKnownRank,
    prefs: cleanPrefs(settings.prefs),
  }
}

/** Flat primitives only, the same shape the backend accepts in the prefs header. */
export function cleanPrefs(prefs: unknown): Record<string, SettingValue> {
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return {}
  const out: Record<string, SettingValue> = {}
  for (const [key, value] of Object.entries(prefs)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) continue
    if (typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      out[key] = value
    }
  }
  return out
}

/**
 * Applies a value from a server-driven settings row. Returns the patch to
 * save, or null when the key is not one the server may change or the value
 * is the wrong type — the server can only reach settings this build exposes.
 */
export function settingPatch(
  settings: LinkLingoSettings,
  key: string,
  value: unknown,
): Partial<LinkLingoSettings> | null {
  if (key.startsWith("prefs.")) {
    const name = key.slice("prefs.".length)
    const next = cleanPrefs({...settings.prefs, [name]: value})
    return name in next ? {prefs: next} : null
  }
  if (!(SETTABLE_KEYS as readonly string[]).includes(key)) return null
  const current = DEFAULT_SETTINGS[key as SettableKey]
  if (typeof value !== typeof current) return null
  return {[key]: value} as Partial<LinkLingoSettings>
}

export function migrateSettings(parsed: Partial<LinkLingoSettings>): LinkLingoSettings {
  const version = parsed.schemaVersion ?? 1
  const next = normalizeSettings({...DEFAULT_SETTINGS, ...parsed})
  const stillOldDefaultPair =
    version < SETTINGS_SCHEMA_VERSION &&
    (parsed.sourceLanguage ?? "en") === "en" &&
    (parsed.targetLanguage ?? "zh") === "zh"

  if (stillOldDefaultPair) {
    next.sourceLanguage = "zh"
    next.targetLanguage = "en"
    next.swapDirection = false
  }
  // v3 locked the HUD to 3 caption slots. A stored 4 or 5 would still be
  // clamped; a stored 2 would leave a short caption block and look like the
  // old jump if we did not lift it.
  if (version < 3) next.displayLines = HUD_CAPTION_LINES
  return normalizeSettings(next)
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min))
}
