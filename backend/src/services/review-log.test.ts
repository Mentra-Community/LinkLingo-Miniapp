import {describe, expect, test} from "bun:test"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"

import {runWithRequestContext} from "../observability/context"
import {formatReviewEntry, ReviewLog, type ReviewEntryInput} from "./review-log"

const HOUR = 3_600_000

function entry(overrides: Partial<ReviewEntryInput> = {}): ReviewEntryInput {
  return {
    op: "gloss",
    model: "test-model",
    promptVersion: "abcd1234",
    inputLanguage: "zh",
    outputLanguage: "en",
    proficiency: 33,
    knownRank: 1000,
    context: "我们今天下午要去参观博物馆",
    candidates: ["博物馆:4156", "参观:3649"],
    outcome: "words",
    raw: '{"words":[{"word":"博物馆","translation":"museum"}]}',
    accepted: [{word: "博物馆 (bó wù guǎn)", translation: "museum"}],
    rejected: [],
    totalMs: 420,
    ...overrides,
  }
}

describe("ReviewLog", () => {
  test("keeps entries newest-last and honours the limit", () => {
    const log = new ReviewLog(24 * HOUR, 100, null)
    for (let i = 0; i < 5; i++) log.record(entry({totalMs: i}), 1_000 + i)
    expect(log.list({}, 2_000).map((e) => e.totalMs)).toEqual([0, 1, 2, 3, 4])
    expect(log.list({limit: 2}, 2_000).map((e) => e.totalMs)).toEqual([3, 4])
  })

  test("forgets entries older than the retention window", () => {
    const log = new ReviewLog(24 * HOUR, 100, null)
    const now = 100 * HOUR
    log.record(entry({totalMs: 1}), now - 25 * HOUR)
    log.record(entry({totalMs: 2}), now - 23 * HOUR)
    log.record(entry({totalMs: 3}), now)
    expect(log.list({}, now).map((e) => e.totalMs)).toEqual([2, 3])
  })

  test("caps the ring at maxEntries", () => {
    const log = new ReviewLog(24 * HOUR, 3, null)
    for (let i = 0; i < 10; i++) log.record(entry({totalMs: i}), 1_000 + i)
    expect(log.list({}, 2_000).map((e) => e.totalMs)).toEqual([7, 8, 9])
  })

  test("filters by op, time window and user", () => {
    const log = new ReviewLog(24 * HOUR, 100, null)
    log.record(entry({op: "gloss"}), 1_000)
    log.record(entry({op: "upgrade"}), 2_000)
    runWithRequestContext({requestId: "r1", userId: "user-a"}, () => log.record(entry({op: "gloss"}), 3_000))
    expect(log.list({op: "upgrade"}, 4_000)).toHaveLength(1)
    expect(log.list({since: 2_000}, 4_000)).toHaveLength(2)
    expect(log.list({since: 1_500, until: 2_500}, 4_000)).toHaveLength(1)
    const tagged = log.list({}, 4_000)[2]
    expect(tagged.requestId).toBe("r1")
    expect(tagged.user).toBeDefined()
    expect(tagged.user).not.toBe("user-a")
    expect(log.list({user: tagged.user}, 4_000)).toHaveLength(1)
  })

  test("summarises outcomes and reject reasons", () => {
    const log = new ReviewLog(24 * HOUR, 100, null)
    log.record(entry({outcome: "words"}), 1_000)
    log.record(entry({outcome: "no_words", rejected: [{word: "x", reason: "untranslated"}]}), 2_000)
    const stats = log.stats(3_000)
    expect(stats.entries).toBe(2)
    expect(stats.byOutcome).toEqual({words: 1, no_words: 1})
    expect(stats.byRejectReason).toEqual({untranslated: 1})
    expect(stats.oldestAt).toBe(1_000)
    expect(stats.newestAt).toBe(2_000)
  })

  test("appends JSONL when a file is configured", () => {
    const file = join(mkdtempSync(join(tmpdir(), "linklingo-review-")), "review.jsonl")
    const log = new ReviewLog(24 * HOUR, 100, file)
    log.record(entry(), 1_000)
    log.record(entry({outcome: "no_words"}), 2_000)
    const lines = readFileSync(file, "utf8").trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).outcome).toBe("no_words")
  })

  test("renders an entry for a human reviewer", () => {
    const log = new ReviewLog(24 * HOUR, 100, null)
    const recorded = log.record(
      entry({rejected: [{word: "ramifications", reason: "untranslated"}]}),
      Date.UTC(2026, 8, 14, 3, 0, 0),
    )
    const text = formatReviewEntry(recorded)
    expect(text).toContain("[2026-09-14 03:00:00] gloss zh→en p=33 known=1000 words 420ms")
    expect(text).toContain("heard:      我们今天下午要去参观博物馆")
    expect(text).toContain("candidates: 博物馆:4156, 参观:3649")
    expect(text).toContain("shown:      博物馆 (bó wù guǎn) -> museum")
    expect(text).toContain("dropped:    ramifications (untranslated)")
    expect(text).toContain("prompt=abcd1234")
  })
})
