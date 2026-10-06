import {describe, expect, test} from "bun:test"

import {buildReport, localDate, reportPeriod} from "./history-report"
import type {HistoryEvent} from "./history-store"

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Shenzhen. */
const TZ = -480

const gloss = (at: number, word: string, translation = "x"): HistoryEvent => ({kind: "gloss", at, word, translation, in: "zh", out: "en"})
const reverse = (at: number, word: string): HistoryEvent => ({kind: "reverse", at, word, translation: "博物馆", in: "en", out: "zh"})

describe("report periods", () => {
  test("a Shenzhen day runs from 16:00 UTC the evening before", () => {
    const period = reportPeriod("day", "2026-10-06", TZ)
    expect(new Date(period.from).toISOString()).toBe("2026-10-05T16:00:00.000Z")
    expect(new Date(period.to + 1).toISOString()).toBe("2026-10-06T16:00:00.000Z")
  })

  test("defaults to today on the phone's calendar, not the server's", () => {
    // 23:30 UTC on the 5th is already 07:30 on the 6th in Shenzhen.
    const now = Date.UTC(2026, 9, 5, 23, 30)
    expect(reportPeriod("day", undefined, TZ, now).date).toBe("2026-10-06")
    expect(localDate(now, 0)).toBe("2026-10-05")
  })

  test("a week is the seven local days ending on the chosen date", () => {
    const period = reportPeriod("week", "2026-10-06", TZ)
    expect(new Date(period.from).toISOString()).toBe("2026-09-29T16:00:00.000Z")
    const report = buildReport(period, [])
    expect(report.days.map((d) => d.date)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ])
  })
})

describe("buildReport", () => {
  const period = reportPeriod("week", "2026-10-06", TZ)
  const t = (day: number, hourLocal: number) => period.from + day * DAY + hourLocal * HOUR

  test("a word glossed late at night lands on the local day it was said", () => {
    // 23:30 local on Oct 1 is 15:30 UTC: still Oct 1 for the learner.
    const report = buildReport(period, [gloss(t(1, 23.5), "博物馆")])
    expect(report.days.find((d) => d.date === "2026-10-01")!.words).toBe(1)
    expect(report.days.find((d) => d.date === "2026-10-02")!.words).toBe(0)
  })

  test("counts, top words, and pinyin-insensitive identity", () => {
    const events = [
      gloss(t(0, 9), "博物馆 (bó wù guǎn)", "museum"),
      gloss(t(1, 9), "博物馆", "museum"),
      gloss(t(2, 9), "博物馆 (bó wù guǎn)", "museum"),
      gloss(t(2, 10), "参观", "to visit"),
      {kind: "heard", at: t(2, 10), count: 40} as HistoryEvent,
    ]
    const report = buildReport(period, events)
    expect(report.totals).toMatchObject({wordsShown: 4, uniqueWords: 2, heard: 40})
    expect(report.topWords[0]).toMatchObject({word: "博物馆 (bó wù guǎn)", count: 3})
    expect(report.mistakes.repeats.map((w) => w.count)).toEqual([3])
  })

  test("a word is new only if it was not glossed in the 90 days before", () => {
    const before = [gloss(period.from - 10 * DAY, "博物馆")]
    const report = buildReport(period, [gloss(t(0, 9), "博物馆"), gloss(t(0, 10), "参观")], before)
    expect(report.newWords.map((w) => w.word)).toEqual(["参观"])
    expect(report.totals.newWords).toBe(1)
  })

  test("fallbacks, flags and review items fill the mistakes section", () => {
    const events: HistoryEvent[] = [
      reverse(t(3, 9), "museum"),
      reverse(t(3, 11), "museum"),
      reverse(t(4, 9), "exhibition"),
      {kind: "flag", at: t(4, 10), id: "f1", note: "that was wrong", change: "started"},
      {kind: "review", at: t(5, 8), items: [{said: "一个博物馆", better: "一家博物馆", rule: "Use 家.", confidence: "high"}]},
    ]
    const report = buildReport(period, events)
    expect(report.mistakes.fallbacks.map((w) => [w.word, w.count])).toEqual([
      ["museum", 2],
      ["exhibition", 1],
    ])
    expect(report.totals.fallbacks).toBe(3)
    expect(report.mistakes.flags).toEqual([{at: t(4, 10), note: "that was wrong", change: "started"}])
    expect(report.mistakes.review[0]).toMatchObject({said: "一个博物馆", better: "一家博物馆", confidence: "high"})
  })

  test("events outside the period are ignored", () => {
    const report = buildReport(period, [gloss(period.from - 1, "早"), gloss(period.to + 1, "晚")])
    expect(report.totals.wordsShown).toBe(0)
  })
})
