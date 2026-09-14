import {describe, expect, test} from "bun:test"

import {TranscriptLog, formatTranscriptEntry} from "./transcript-log"

const HOUR = 3_600_000

describe("TranscriptLog", () => {
  test("annotates Chinese speech with the words the filter would gloss", () => {
    const log = new TranscriptLog(24 * HOUR, 100, null)
    const entry = log.record({
      text: "我们今天下午要去参观博物馆，然后在附近的餐厅吃晚饭。",
      inputLanguage: "zh",
      outputLanguage: "en",
      fluencyLevel: 10,
      mode: "gloss-captions",
      disposition: "queued_gloss",
    })
    expect(entry.wouldGloss.some((c) => c.startsWith("博物馆:"))).toBe(true)
    expect(formatTranscriptEntry(entry)).toContain("heard:      我们今天下午")
  })

  test("English speech in a Chinese session is stored with no candidates", () => {
    const log = new TranscriptLog(24 * HOUR, 100, null)
    const entry = log.record({
      text: "Her thesis examines the socioeconomic ramifications of urbanization.",
      detectedLanguage: "en-US",
      inputLanguage: "zh",
      outputLanguage: "en",
      fluencyLevel: 10,
      mode: "gloss-captions",
      disposition: "skipped_language",
    })
    expect(entry.wouldGloss).toEqual([])
    expect(entry.disposition).toBe("skipped_language")
  })

  test("forgets entries older than a day", () => {
    const log = new TranscriptLog(24 * HOUR, 100, null)
    const now = 100 * HOUR
    log.record(
      {text: "old", inputLanguage: "zh", outputLanguage: "en", fluencyLevel: 10, mode: "gloss", disposition: "heard"},
      now - 25 * HOUR,
    )
    log.record(
      {text: "new", inputLanguage: "zh", outputLanguage: "en", fluencyLevel: 10, mode: "gloss", disposition: "heard"},
      now,
    )
    expect(log.list({}, now).map((e) => e.text)).toEqual(["new"])
  })
})
