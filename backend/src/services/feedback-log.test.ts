import {describe, expect, test} from "bun:test"

import {FeedbackLog, formatFeedbackEntry, type FeedbackEntryInput} from "./feedback-log"

function input(overrides: Partial<FeedbackEntryInput> = {}): FeedbackEntryInput {
  return {
    note: "it glossed 餐厅 which I know",
    snapshot: {
      settings: {inputLanguage: "zh", outputLanguage: "en", proficiency: 33, mode: "gloss-captions"},
      recentUtterances: [{text: "我们去餐厅吃饭", at: 1_000, language: "zh"}],
      shownWords: [{word: "餐厅", translation: "restaurant", at: 1_200}],
      recentWords: [{word: "餐厅", translation: "restaurant", at: 1_200}],
      caption: "我们去餐厅吃饭",
      translation: "",
      original: "",
    },
    tape: {transcripts: 3, glossCalls: 1, windowMs: 600_000},
    analysis: {
      id: "",
      model: "gemini-3.1-pro-preview",
      answer: "餐厅 ranks 1700, above your known rank of 1500, so the filter offered it. Raise proficiency a notch.",
      totalMs: 4200,
    },
    ...overrides,
  }
}

describe("FeedbackLog", () => {
  test("keeps entries within retention and drops the oldest past it", () => {
    const log = new FeedbackLog(60_000, 100, null)
    log.record(input(), 0)
    log.record(input(), 30_000)
    log.record(input(), 90_000)
    const kept = log.list({}, 90_000)
    expect(kept.map((e) => e.at)).toEqual([30_000, 90_000])
  })

  test("filters by window and caps by limit", () => {
    const log = new FeedbackLog(3_600_000, 100, null)
    for (let i = 0; i < 5; i++) log.record(input(), i * 1000)
    expect(log.list({since: 2000}, 5000).map((e) => e.at)).toEqual([2000, 3000, 4000])
    expect(log.list({limit: 2}, 5000).map((e) => e.at)).toEqual([3000, 4000])
  })

  test("stats report the window", () => {
    const log = new FeedbackLog(3_600_000, 100, null)
    log.record(input(), 0)
    log.record(input(), 2)
    expect(log.stats(2)).toMatchObject({entries: 2, oldestAt: 0, newestAt: 2, retentionHours: 1})
  })

  test("format shows note, rows and the answer", () => {
    const log = new FeedbackLog(3_600_000, 100, null)
    const entry = log.record(
      input({snapshot: {...input().snapshot, recentWords: [...input().snapshot.recentWords, {word: "参观", translation: "to visit", at: 900}]}}),
      0,
    )
    const text = formatFeedbackEntry(entry)
    expect(text).toContain("user said:  it glossed 餐厅 which I know")
    expect(text).toContain("on glasses: 餐厅 -> restaurant")
    expect(text).toContain("earlier:    参观 -> to visit")
    expect(text).toContain("analyst:    餐厅 ranks 1700")
    expect(text).toContain("tape=3t/1g")
  })
})
