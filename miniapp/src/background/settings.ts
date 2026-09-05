import type {MiniappSession} from "@mentra/miniapp/background"

import {
  DEFAULT_SETTINGS,
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
    displayLines: clamp(settings.displayLines, 2, 5),
    displayWidth: settings.displayWidth === 0 || settings.displayWidth === 2 ? settings.displayWidth : 1,
  }
}

export function migrateSettings(parsed: Partial<LinkLingoSettings>): LinkLingoSettings {
  const version = parsed.schemaVersion ?? 1
  const next = normalizeSettings({...DEFAULT_SETTINGS, ...parsed})
  const stillOldDefaultPair =
    version < SETTINGS_SCHEMA_VERSION &&
    (parsed.sourceLanguage ?? "en") === "en" &&
    (parsed.targetLanguage ?? "zh") === "zh"

  if (!stillOldDefaultPair) {
    return next
  }

  return normalizeSettings({
    ...next,
    sourceLanguage: "zh",
    targetLanguage: "en",
    swapDirection: false,
  })
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min))
}
