import {describe, expect, test} from "bun:test"

import {DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION} from "../shared/types"
import {migrateSettings, normalizeSettings} from "./settings"

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
})
