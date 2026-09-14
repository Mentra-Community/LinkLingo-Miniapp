import {describe, expect, test} from "bun:test"

import {DEFAULT_SETTINGS, HUD_CAPTION_LINES, HUD_WORD_ROWS, type GlossedWord, type LinkLingoSettings} from "../shared/types"
import {composeHud, EMPTY_ROW, IDLE_LINE} from "./DisplayRenderer"

const word = (w: string, t: string, isUpgrade = false): GlossedWord => ({word: w, translation: t, at: 0, isUpgrade})
const settings = (mode: LinkLingoSettings["mode"]): LinkLingoSettings => ({...DEFAULT_SETTINGS, mode})
const state = (words: GlossedWord[], caption = "") => ({words, caption, translation: "", original: ""})

const rows = (frame: string) => frame.split("\n")
const CAPTION_START = HUD_WORD_ROWS + 1

describe("composeHud with captions", () => {
  const captions = settings("gloss-captions")

  test("reserves 3 word slots, a gap, and 3 caption slots", () => {
    const frame = rows(composeHud(state([word("博物馆", "museum")], "heard"), captions))
    expect(frame).toHaveLength(HUD_WORD_ROWS + 1 + HUD_CAPTION_LINES)
    expect(frame[3]).toBe(EMPTY_ROW)
    expect(frame[CAPTION_START]).toBe("heard")
  })

  test("the first caption line stays put as words and caption lines arrive", () => {
    const none = rows(composeHud(state([], "line one"), captions))
    const one = rows(composeHud(state([word("博物馆", "museum")], "line one"), captions))
    const two = rows(
      composeHud(state([word("博物馆", "museum"), word("参观", "to visit")], "line one\nline two"), captions),
    )
    const three = rows(
      composeHud(
        state(
          [word("博物馆", "museum"), word("参观", "to visit"), word("餐厅", "restaurant")],
          "line one\nline two\nline three",
        ),
        captions,
      ),
    )
    expect(none[CAPTION_START]).toBe("line one")
    expect(one[CAPTION_START]).toBe("line one")
    expect(two[CAPTION_START]).toBe("line one")
    expect(three[CAPTION_START]).toBe("line one")
    expect(three[0]).toBe("博物馆 -> museum")
    expect(three[1]).toBe("参观 -> to visit")
    expect(three[2]).toBe("餐厅 -> restaurant")
  })

  test("empty word slots are padded so the gap never moves", () => {
    expect(rows(composeHud(state([], "caption"), captions)).slice(0, 4)).toEqual([
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ])
    expect(rows(composeHud(state([word("博物馆", "museum")], "caption"), captions)).slice(0, 4)).toEqual([
      "博物馆 -> museum",
      EMPTY_ROW,
      EMPTY_ROW,
      EMPTY_ROW,
    ])
  })

  test("existing words keep their row when the next one arrives", () => {
    const one = rows(composeHud(state([word("博物馆", "museum")], "c"), captions))
    const two = rows(composeHud(state([word("博物馆", "museum"), word("参观", "to visit")], "c"), captions))
    expect(one[0]).toBe("博物馆 -> museum")
    expect(two[0]).toBe("博物馆 -> museum")
    expect(two[1]).toBe("参观 -> to visit")
  })

  test("a fourth word drops the oldest; remaining words and the caption stay put", () => {
    const three = [word("博物馆", "museum"), word("参观", "to visit"), word("餐厅", "restaurant")]
    const four = [...three, word("附近", "nearby")]
    const before = rows(composeHud(state(three, "heard"), captions))
    const after = rows(composeHud(state(four, "heard"), captions))
    expect(after[0]).toBe("参观 -> to visit")
    expect(after[1]).toBe("餐厅 -> restaurant")
    expect(after[2]).toBe("附近 -> nearby")
    expect(after[CAPTION_START]).toBe(before[CAPTION_START])
  })

  test("words without a caption still hold the full frame", () => {
    const frame = rows(composeHud(state([word("博物馆", "museum")]), captions))
    expect(frame).toHaveLength(HUD_WORD_ROWS + 1 + HUD_CAPTION_LINES)
    expect(frame[0]).toBe("博物馆 -> museum")
    expect(frame[CAPTION_START]).toBe(EMPTY_ROW)
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

  test("uses the same reserved frame so a mode switch does not jump", () => {
    const frame = rows(composeHud(state([word("博物馆", "museum")], "caption"), gloss))
    expect(frame).toHaveLength(HUD_WORD_ROWS + 1 + HUD_CAPTION_LINES)
    expect(frame[0]).toBe("博物馆 -> museum")
    expect(frame[3]).toBe(EMPTY_ROW)
    expect(frame[CAPTION_START]).toBe("caption")
  })

  test("falls back to the caption slots, then the idle line", () => {
    const fallback = rows(composeHud(state([], "caption"), gloss))
    expect(fallback[CAPTION_START]).toBe("caption")
    expect(composeHud(state([]), gloss)).toBe(IDLE_LINE)
  })
})

describe("composeHud translation", () => {
  test("shows translation over original", () => {
    const frame = composeHud({words: [], caption: "", translation: "museum", original: "博物馆"}, settings("translation"))
    expect(rows(frame)).toEqual(["museum", "博物馆"])
  })
})
