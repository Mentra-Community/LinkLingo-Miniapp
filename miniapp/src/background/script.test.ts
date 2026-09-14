import {describe, expect, test} from "bun:test"

import {scriptOfLanguage, scriptOfText, utteranceInInputLanguage} from "../shared/script"

describe("phone-side language guard", () => {
  test("recognises the languages the settings screen offers", () => {
    expect(scriptOfLanguage("zh")).toBe("han")
    expect(scriptOfLanguage("zh-CN")).toBe("han")
    expect(scriptOfLanguage("en")).toBe("latin")
    expect(scriptOfLanguage("ru")).toBe("cyrillic")
    expect(scriptOfLanguage("ko")).toBe("hangul")
  })

  test("reads the dominant script of an utterance", () => {
    expect(scriptOfText("我们今天下午要去参观博物馆")).toBe("han")
    expect(scriptOfText("Her thesis examines the ramifications")).toBe("latin")
    expect(scriptOfText("我们去 museum")).toBe("han")
    expect(scriptOfText("I met 李明 at the conference yesterday")).toBe("latin")
    expect(scriptOfText("...")).toBe("unknown")
  })

  test("English speech is skipped when hearing Chinese and reading English", () => {
    expect(utteranceInInputLanguage("Her thesis examines the ramifications", "zh", "en")).toBe(false)
    expect(utteranceInInputLanguage("我们今天下午要去参观博物馆", "zh", "en")).toBe(true)
  })

  test("the reverse direction is symmetric", () => {
    expect(utteranceInInputLanguage("我们今天下午要去参观博物馆", "en", "zh")).toBe(false)
    expect(utteranceInInputLanguage("Her thesis examines the ramifications", "en", "zh")).toBe(true)
  })

  test("same-script pairs and punctuation-only text always pass", () => {
    expect(utteranceInInputLanguage("Her thesis examines", "es", "en")).toBe(true)
    expect(utteranceInInputLanguage("...", "zh", "en")).toBe(true)
  })
})
