import {describe, expect, test} from "bun:test"

import {candidateWords, knownRankFor} from "./frequency"
import {looksUntranslated, scriptOfLanguage, scriptOfText, tokenInInputLanguage} from "./script"

describe("script detection", () => {
  test("maps language codes and names to a script", () => {
    expect(scriptOfLanguage("zh")).toBe("han")
    expect(scriptOfLanguage("zh-CN")).toBe("han")
    expect(scriptOfLanguage("Chinese (Pinyin)")).toBe("han")
    expect(scriptOfLanguage("English")).toBe("latin")
    expect(scriptOfLanguage("es")).toBe("latin")
    expect(scriptOfLanguage("ru")).toBe("cyrillic")
    expect(scriptOfLanguage("klingon")).toBe("unknown")
  })

  test("picks the dominant script of mixed text", () => {
    expect(scriptOfText("博物馆")).toBe("han")
    expect(scriptOfText("museum")).toBe("latin")
    expect(scriptOfText("博物馆 (bó wù guǎn)")).toBe("han")
    expect(scriptOfText("参观 (cān guān)")).toBe("han")
    expect(scriptOfText("museum (博物馆)")).toBe("latin")
    // A Chinese sentence with an English loanword is still Chinese speech,
    // and an English sentence with a Chinese name is still English.
    expect(scriptOfText("我们去 museum")).toBe("han")
    expect(scriptOfText("I met 李明 at the conference yesterday")).toBe("latin")
    expect(scriptOfText("2024")).toBe("unknown")
  })

  test("a token in the output language is not input vocabulary", () => {
    expect(tokenInInputLanguage("ramifications", "zh", "en")).toBe(false)
    expect(tokenInInputLanguage("博物馆", "zh", "en")).toBe(true)
    expect(tokenInInputLanguage("博物馆", "en", "zh")).toBe(false)
    expect(tokenInInputLanguage("ramifications", "en", "zh")).toBe(true)
  })

  test("same-script pairs are never filtered", () => {
    expect(tokenInInputLanguage("ramifications", "es", "en")).toBe(true)
    expect(tokenInInputLanguage("consecuencias", "en", "es")).toBe(true)
  })

  test("a translation still in the input script is untranslated", () => {
    expect(looksUntranslated("consequences", "zh", "en")).toBe(false)
    expect(looksUntranslated("影响", "zh", "en")).toBe(true)
    expect(looksUntranslated("影响", "en", "zh")).toBe(false)
    expect(looksUntranslated("consequences", "en", "zh")).toBe(true)
    expect(looksUntranslated("consecuencias", "en", "es")).toBe(false)
  })
})

describe("candidate selection language guard", () => {
  const beginner = knownRankFor(10)

  test("English speech in a Chinese session yields no candidates", () => {
    const words = candidateWords(
      "Her thesis examines the socioeconomic ramifications of urbanization.",
      "zh",
      [],
      beginner,
      "en",
    )
    expect(words).toEqual([])
  })

  test("English words inside Chinese speech are dropped, Chinese ones kept", () => {
    const words = candidateWords("我们今天下午要去参观博物馆 and discuss the ramifications", "zh", [], beginner, "en")
    const list = words.map((c) => c.word)
    expect(list).toContain("博物馆")
    expect(list).not.toContain("ramifications")
  })

  test("without an output language every token is scored, as the corpus checks expect", () => {
    const words = candidateWords("我们要去参观博物馆 and discuss the ramifications", "zh", [], beginner)
    expect(words.map((c) => c.word)).toContain("ramifications")
  })
})
