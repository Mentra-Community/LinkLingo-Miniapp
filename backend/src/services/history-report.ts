/**
 * Turns ledger events into the dashboard's day and week reports. Pure, so the
 * local-day arithmetic can be tested without a bucket. Days are the phone's
 * calendar days: a Shenzhen learner's Tuesday ends at 16:00 UTC.
 */

import type {Report, ReportDay, ReportRange, ReportWord} from "../shared-types"
import type {HistoryEvent} from "./history-store"

const DAY_MS = 86_400_000
/** Glossed this often in one period means the word is not sticking yet. */
export const REPEAT_THRESHOLD = 3
const TOP_WORDS = 12
const NEW_WORDS = 30
const MAX_FLAGS = 20

export interface ReportPeriod {
  range: ReportRange
  date: string
  tzOffsetMin: number
  from: number
  to: number
}

/** `tzOffsetMin` is `Date#getTimezoneOffset()`: minutes to add to local time to get UTC (UTC+8 is -480). */
export function localDate(at: number, tzOffsetMin: number): string {
  return new Date(at - tzOffsetMin * 60_000).toISOString().slice(0, 10)
}

function localMidnight(date: string, tzOffsetMin: number): number {
  return Date.parse(`${date}T00:00:00.000Z`) + tzOffsetMin * 60_000
}

export function reportPeriod(range: ReportRange, date: string | undefined, tzOffsetMin: number, now = Date.now()): ReportPeriod {
  const end = date ?? localDate(now, tzOffsetMin)
  const endStart = localMidnight(end, tzOffsetMin)
  const from = range === "week" ? endStart - 6 * DAY_MS : endStart
  return {range, date: end, tzOffsetMin, from, to: endStart + DAY_MS - 1}
}

/** Pinyin and casing are display, not identity: 博物馆 (bó wù guǎn) and 博物馆 are one word. */
function wordKey(word: string): string {
  return word.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()
}

function tally(events: Array<Extract<HistoryEvent, {kind: "gloss" | "reverse"}>>): Map<string, ReportWord> {
  const words = new Map<string, ReportWord>()
  for (const e of events) {
    const key = wordKey(e.word)
    const existing = words.get(key)
    if (existing) {
      existing.count += 1
      if (e.at >= existing.lastAt) {
        existing.lastAt = e.at
        existing.translation = e.translation
      }
    } else {
      words.set(key, {word: e.word, translation: e.translation, count: 1, lastAt: e.at})
    }
  }
  return words
}

const byCount = (a: ReportWord, b: ReportWord) => b.count - a.count || b.lastAt - a.lastAt

/**
 * `events` covers the period; `before` covers the 90 days preceding it and is
 * only used to decide which words are new.
 */
export function buildReport(period: ReportPeriod, events: HistoryEvent[], before: HistoryEvent[] = []): Report {
  const inPeriod = events.filter((e) => e.at >= period.from && e.at <= period.to)
  const glosses = inPeriod.filter((e): e is Extract<HistoryEvent, {kind: "gloss"}> => e.kind === "gloss")
  const reverses = inPeriod.filter((e): e is Extract<HistoryEvent, {kind: "reverse"}> => e.kind === "reverse")
  const flags = inPeriod.filter((e): e is Extract<HistoryEvent, {kind: "flag"}> => e.kind === "flag")
  const reviews = inPeriod.filter((e): e is Extract<HistoryEvent, {kind: "review"}> => e.kind === "review")

  const glossWords = tally(glosses)
  const seenBefore = new Set(
    before.filter((e) => e.kind === "gloss" && e.at < period.from).map((e) => wordKey((e as {word: string}).word)),
  )
  const newWords = [...glossWords.entries()].filter(([key]) => !seenBefore.has(key)).map(([, w]) => w)

  const dayCount = period.range === "week" ? 7 : 1
  const days: ReportDay[] = []
  const dayIndex = new Map<string, ReportDay>()
  for (let i = 0; i < dayCount; i++) {
    const date = localDate(period.from + i * DAY_MS + 1, period.tzOffsetMin)
    const day = {date, words: 0, fallbacks: 0, heard: 0}
    days.push(day)
    dayIndex.set(date, day)
  }
  for (const e of inPeriod) {
    const day = dayIndex.get(localDate(e.at, period.tzOffsetMin))
    if (!day) continue
    if (e.kind === "gloss") day.words += 1
    else if (e.kind === "reverse") day.fallbacks += 1
    else if (e.kind === "heard") day.heard += e.count
  }

  return {
    range: period.range,
    date: period.date,
    tzOffsetMin: period.tzOffsetMin,
    from: period.from,
    to: period.to,
    totals: {
      wordsShown: glosses.length,
      uniqueWords: glossWords.size,
      newWords: newWords.length,
      heard: days.reduce((sum, d) => sum + d.heard, 0),
      fallbacks: reverses.length,
      flags: flags.length,
    },
    days,
    topWords: [...glossWords.values()].sort(byCount).slice(0, TOP_WORDS),
    newWords: newWords.sort((a, b) => b.lastAt - a.lastAt).slice(0, NEW_WORDS),
    mistakes: {
      fallbacks: [...tally(reverses).values()].sort(byCount),
      repeats: [...glossWords.values()].filter((w) => w.count >= REPEAT_THRESHOLD).sort(byCount),
      flags: flags
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_FLAGS)
        .map((f) => ({at: f.at, note: f.note, change: f.change})),
      review: reviews
        .sort((a, b) => b.at - a.at)
        .flatMap((r) => r.items.map((item) => ({at: r.at, ...item}))),
    },
  }
}
