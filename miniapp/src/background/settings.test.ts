import {describe, expect, test} from "bun:test"

import {DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION} from "../shared/types"
import {loadSettings, migrateSettings, normalizeSettings, saveSettings} from "./settings"

describe("settings defaults", () => {
  test("factory pair is Chinese heard, English gloss", () => {
    expect(DEFAULT_SETTINGS.sourceLanguage).toBe("zh")
    expect(DEFAULT_SETTINGS.targetLanguage).toBe("en")
    expect(DEFAULT_SETTINGS.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  test("empty codes fall back to Chinese → English", () => {
    const next = normalizeSettings({
      ...DEFAULT_SETTINGS,
      sourceLanguage: "",
      targetLanguage: "",
    })
    expect(next.sourceLanguage).toBe("zh")
    expect(next.targetLanguage).toBe("en")
  })
})

describe("migrateSettings", () => {
  test("flips the old English → Chinese factory pair", () => {
    const next = migrateSettings({
      sourceLanguage: "en",
      targetLanguage: "zh",
      swapDirection: false,
      proficiency: 33,
      mode: "gloss-captions",
      wordUpgrades: false,
      displayLines: 2,
      displayWidth: 1,
      wordBreaking: false,
      pinyinDisplay: true,
    })
    expect(next.sourceLanguage).toBe("zh")
    expect(next.targetLanguage).toBe("en")
    expect(next.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  test("keeps a custom pair", () => {
    const next = migrateSettings({
      sourceLanguage: "fr",
      targetLanguage: "en",
      swapDirection: false,
      proficiency: 50,
      mode: "gloss",
      wordUpgrades: true,
      displayLines: 3,
      displayWidth: 2,
      wordBreaking: true,
      pinyinDisplay: false,
    })
    expect(next.sourceLanguage).toBe("fr")
    expect(next.targetLanguage).toBe("en")
    expect(next.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  test("lifts a pre-v3 caption-line setting to the locked 3-line block", () => {
    const next = migrateSettings({
      schemaVersion: 2,
      sourceLanguage: "zh",
      targetLanguage: "en",
      displayLines: 2,
    })
    expect(next.displayLines).toBe(3)
    expect(next.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })
})

describe("learningCapture setting", () => {
  const fakeSession = () => {
    const store = new Map<string, string>()
    return {
      store,
      session: {
        storage: {
          get: async (k: string) => store.get(k) ?? null,
          set: async (k: string, v: string) => void store.set(k, v),
        },
      } as never,
    }
  }

  test("defaults to off", () => {
    expect(DEFAULT_SETTINGS.learningCapture).toBe(false)
    expect(normalizeSettings({...DEFAULT_SETTINGS}).learningCapture).toBe(false)
  })

  test("normalizer keeps only a real boolean true", () => {
    expect(normalizeSettings({...DEFAULT_SETTINGS, learningCapture: true}).learningCapture).toBe(true)
    expect(normalizeSettings({...DEFAULT_SETTINGS, learningCapture: "yes" as never}).learningCapture).toBe(false)
    expect(normalizeSettings({...DEFAULT_SETTINGS, learningCapture: undefined as never}).learningCapture).toBe(false)
  })

  test("settings stored before the key existed load as off", () => {
    const next = migrateSettings({schemaVersion: 3, sourceLanguage: "zh", targetLanguage: "en"})
    expect(next.learningCapture).toBe(false)
  })

  test("persists across a WebView/app restart", async () => {
    const {session} = fakeSession()
    await saveSettings(session, normalizeSettings({...DEFAULT_SETTINGS, learningCapture: true}))
    const reloaded = await loadSettings(session)
    expect(reloaded.learningCapture).toBe(true)
  })
})
