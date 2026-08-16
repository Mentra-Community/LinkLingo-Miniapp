import type {MiniappSession} from "@mentra/miniapp/background"

import {DEFAULT_SETTINGS, type LinkLingoMode, type LinkLingoSettings} from "../shared/types"

const KEY = "linklingo:settings"

export async function loadSettings(session: MiniappSession): Promise<LinkLingoSettings> {
  try {
    const raw = await session.storage.get(KEY)
    if (!raw) return {...DEFAULT_SETTINGS}
    const parsed = JSON.parse(raw) as Partial<LinkLingoSettings>
    return normalizeSettings({...DEFAULT_SETTINGS, ...parsed})
  } catch {
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
    sourceLanguage: settings.sourceLanguage || "en",
    targetLanguage: settings.targetLanguage || "zh",
    proficiency: clamp(settings.proficiency, 0, 100),
    mode: modes.includes(settings.mode) ? settings.mode : "gloss-captions",
    displayLines: clamp(settings.displayLines, 2, 5),
    displayWidth: settings.displayWidth === 0 || settings.displayWidth === 2 ? settings.displayWidth : 1,
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min))
}
