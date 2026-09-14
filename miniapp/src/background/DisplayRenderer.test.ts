import {describe, expect, test} from "bun:test"

import {DEFAULT_SETTINGS, type GlossedWord, type LinkLingoSettings} from "../shared/types"
import {composeHud, EMPTY_ROW, IDLE_LINE} from "./DisplayRenderer"

const word = (w: string, t: string, isUpgrade = false): GlossedWord => ({word: w, translation: t, at: 0, isUpgrade})
const settings = (mode: LinkLingoSettings["mode"]): LinkLingoSettings => ({...DEFAULT_SETTINGS, mode})
const state = (words: GlossedWord[], caption = "") => ({words, caption, translation: "", original: ""})

const rows = (frame: string) => frame.split("\n")

describe("composeHud with captions", () => {
  const captions = settings("gloss-captions")

  test("the caption stays on the same row as words arrive", () => {
    const none = rows(composeHud(state([], "我们今天下午要去参观博物馆"), captions))
    const one = rows(composeHud(state([word("博物馆", "museum")], "我们今天下午要去参观博物馆"), captions))
    const two = rows(
      composeHud(state([word("博物馆", "museum"), word("参观", "to visit")], "我们今天下午要去参观博物馆"), captions),
    )
    expect(none.indexOf("我们今天下午要去参观博物馆")).toBe(2)
    expect(one.indexOf("我们今天下午要去参观博物馆")).toBe(2)
    expect(two.indexOf("我们今天下午要去参观博物馆")).toBe(2)
  })

  test("empty word slots are padded with a visible-width row", () => {
    expect(rows(composeHud(state([], "caption"), captions))).toEqual([EMPTY_ROW, EMPTY_ROW, "caption"])
    expect(rows(composeHud(state([word("博物馆", "museum")], "caption"), captions))).toEqual([
      "博物馆 -> museum",
      EMPTY_ROW,
      "caption",
    ])
  })

  test("existing words keep their row when the next one arrives", () => {
    const one = rows(composeHud(state([word("博物馆", "museum")], "c"), captions))
    const two = rows(composeHud(state([word("博物馆", "museum"), word("参观", "to visit")], "c"), captions))
    expect(one[0]).toBe("博物馆 -> museum")
    expect(two[0]).toBe("博物馆 -> museum")
    expect(two[1]).toBe("参观 -> to visit")
  })

  test("words without a caption still hold the block height", () => {
    expect(rows(composeHud(state([word("博物馆", "museum")]), captions))).toEqual(["博物馆 -> museum", EMPTY_ROW])
  })

  test("nothing at all shows the idle line", () => {
    expect(composeHud(state([]), captions)).toBe(IDLE_LINE)
  })

  test("upgrades are marked", () => {
    expect(rows(composeHud(state([word("天下无敌", "unbeatable", true)], "c"), captions))[0]).toBe(
      "^ 天下无敌 -> unbeatable",
    )
  })
})

describe("composeHud words-only", () => {
  const gloss = settings("gloss")

  test("does not pad, since nothing sits below the words", () => {
    expect(composeHud(state([word("博物馆", "museum")]), gloss)).toBe("博物馆 -> museum")
  })

  test("falls back to the caption, then the idle line", () => {
    expect(composeHud(state([], "caption"), gloss)).toBe("caption")
    expect(composeHud(state([]), gloss)).toBe(IDLE_LINE)
  })
})

describe("composeHud translation", () => {
  test("shows translation over original", () => {
    const frame = composeHud({words: [], caption: "", translation: "museum", original: "博物馆"}, settings("translation"))
    expect(rows(frame)).toEqual(["museum", "博物馆"])
  })
})
