import {afterEach, describe, expect, test} from "bun:test"

import {DEFAULT_CONFIG} from "../shared/defaultConfig"
import {DEFAULT_TUNABLES} from "../shared/serverContract"
import {DEFAULT_SETTINGS} from "../shared/types"
import {holds, settingValue} from "../ui/Blocks"
import {validConfig} from "./remoteConfig"
import {cleanPrefs, normalizeSettings, settingPatch} from "./settings"
import {applyTunables, resetTunables, tunable} from "./tunables"

afterEach(() => resetTunables())

describe("tunables", () => {
  test("a valid server value replaces the built-in default", () => {
    expect(applyTunables({glossCooldownMs: 900})).toEqual(["glossCooldownMs"])
    expect(tunable("glossCooldownMs")).toBe(900)
  })

  test("unknown names and out-of-range values are ignored one by one", () => {
    applyTunables({glossCooldownMs: 99_999, mystery: 4, reverseMaxWords: 3, wordTtlMs: "long"})
    expect(tunable("glossCooldownMs")).toBe(DEFAULT_TUNABLES.glossCooldownMs)
    expect(tunable("reverseMaxWords")).toBe(3)
    expect(tunable("wordTtlMs")).toBe(DEFAULT_TUNABLES.wordTtlMs)
  })

  test("a new config that drops a tunable falls back to the default, not the old value", () => {
    applyTunables({interimStableMs: 800})
    applyTunables({})
    expect(tunable("interimStableMs")).toBe(DEFAULT_TUNABLES.interimStableMs)
  })
})

describe("server-driven settings", () => {
  test("built-in keys only take values of the right type", () => {
    expect(settingPatch(DEFAULT_SETTINGS, "reverseGloss", false)).toEqual({reverseGloss: false})
    expect(settingPatch(DEFAULT_SETTINGS, "reverseGloss", "no")).toBeNull()
    expect(settingPatch(DEFAULT_SETTINGS, "reverseKnownRank", 1500)).toEqual({reverseKnownRank: 1500})
  })

  test("the server cannot reach settings this build does not expose", () => {
    expect(settingPatch(DEFAULT_SETTINGS, "sourceLanguage", "fr")).toBeNull()
    expect(settingPatch(DEFAULT_SETTINGS, "schemaVersion", 9)).toBeNull()
  })

  test("prefs.* creates a backend-only setting the phone has never heard of", () => {
    const patch = settingPatch(DEFAULT_SETTINGS, "prefs.repeatThreshold", 2)
    expect(patch).toEqual({prefs: {repeatThreshold: 2}})
    expect(settingPatch(DEFAULT_SETTINGS, "prefs.bad key", 2)).toBeNull()
    expect(cleanPrefs({ok: 1, nested: {a: 1}, list: [1]})).toEqual({ok: 1})
  })

  test("a server-offered reverse cut is clamped instead of rejected", () => {
    expect(normalizeSettings({...DEFAULT_SETTINGS, reverseKnownRank: 5}).reverseKnownRank).toBe(100)
    expect(normalizeSettings({...DEFAULT_SETTINGS, reverseKnownRank: 1500}).reverseKnownRank).toBe(1500)
  })

  test("rows read and show/hide from built-in settings and prefs alike", () => {
    const settings = {...DEFAULT_SETTINGS, prefs: {repeatThreshold: 4}}
    expect(settingValue(settings, "prefs.repeatThreshold")).toBe(4)
    expect(settingValue(settings, "reverseGloss")).toBe(true)
    expect(holds({key: "reverseGloss", equals: true}, settings)).toBe(true)
    expect(holds({key: "mode", equals: "translation"}, settings)).toBe(false)
    expect(holds(undefined, settings)).toBe(false)
  })
})

describe("config validation", () => {
  test("a malformed server config is rejected so the last good copy stays", () => {
    expect(validConfig(null)).toBeNull()
    expect(validConfig({revision: "x"})).toBeNull()
    expect(validConfig({...DEFAULT_CONFIG, settings: "nope"})).toBeNull()
  })

  test("screens with unsafe ids are dropped, the rest kept", () => {
    const config = validConfig({...DEFAULT_CONFIG, screens: [{id: "reports", title: "Reports"}, {id: "../etc", title: "x"}]})
    expect(config?.screens.map((s) => s.id)).toEqual(["reports"])
  })
})
