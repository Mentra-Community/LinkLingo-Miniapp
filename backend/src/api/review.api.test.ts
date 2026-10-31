import {afterAll, beforeEach, describe, expect, test} from "bun:test"

import {setVocabularyScanner} from "../services/learning-runtime"
import {reviewLog} from "../services/review-log"
import {transcriptLog} from "../services/transcript-log"
import type {VocabularyScanner} from "../services/vocabulary-scan"
import {parseTime, reviewApi} from "./review.api"

const previousToken = process.env.LINKLINGO_REVIEW_TOKEN

afterAll(() => {
  setVocabularyScanner(null)
  if (previousToken === undefined) delete process.env.LINKLINGO_REVIEW_TOKEN
  else process.env.LINKLINGO_REVIEW_TOKEN = previousToken
})

beforeEach(() => {
  reviewLog.clear()
  transcriptLog.clear()
  process.env.LINKLINGO_REVIEW_TOKEN = "s3cret"
  reviewLog.record({
    op: "gloss",
    model: "m",
    promptVersion: "p",
    inputLanguage: "zh",
    outputLanguage: "en",
    proficiency: 33,
    knownRank: 1000,
    context: "我们去参观博物馆",
    candidates: ["博物馆:4156"],
    outcome: "words",
    raw: "{}",
    accepted: [{word: "博物馆", translation: "museum"}],
    rejected: [],
    totalMs: 5,
  })
  reviewLog.record({
    op: "upgrade",
    model: "m",
    promptVersion: "p",
    inputLanguage: "zh",
    outputLanguage: "en",
    proficiency: 33,
    knownRank: 1000,
    context: "我们去参观博物馆",
    outcome: "suggested",
    accepted: [{word: "天下无敌", translation: "unbeatable"}],
    rejected: [],
    totalMs: 7,
  })
})

const auth = {headers: {Authorization: "Bearer s3cret"}}

describe("review api", () => {
  test("does not exist when no token is configured", async () => {
    delete process.env.LINKLINGO_REVIEW_TOKEN
    const res = await reviewApi.request("/entries", auth)
    expect(res.status).toBe(404)
  })

  test("rejects a missing or wrong token", async () => {
    expect((await reviewApi.request("/entries")).status).toBe(401)
    expect((await reviewApi.request("/entries", {headers: {Authorization: "Bearer nope"}})).status).toBe(401)
  })

  test("lists entries as json and filters by op", async () => {
    const all = (await (await reviewApi.request("/entries", auth)).json()) as {count: number; entries: unknown[]}
    expect(all.count).toBe(2)
    const upgrades = (await (await reviewApi.request("/entries?op=upgrade", auth)).json()) as {
      entries: Array<{op: string}>
    }
    expect(upgrades.entries.map((e) => e.op)).toEqual(["upgrade"])
    expect((await reviewApi.request("/entries?op=bogus", auth)).status).toBe(400)
  })

  test("renders text for a terminal", async () => {
    const res = await reviewApi.request("/entries?format=text", auth)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("shown:      博物馆 -> museum")
    expect(body).toContain("shown:      天下无敌 -> unbeatable")
  })

  test("reports stats", async () => {
    const stats = (await (await reviewApi.request("/stats", auth)).json()) as {
      review: {entries: number; byOutcome: object}
      transcripts: {entries: number}
    }
    expect(stats.review.entries).toBe(2)
    expect(stats.review.byOutcome).toEqual({words: 1, suggested: 1})
    expect(stats.transcripts.entries).toBe(0)
  })

  test("lists the transcript tape", async () => {
    transcriptLog.record({
      text: "我们今天下午要去参观博物馆",
      inputLanguage: "zh",
      outputLanguage: "en",
      fluencyLevel: 10,
      mode: "gloss-captions",
      disposition: "queued_gloss",
    })
    const json = (await (await reviewApi.request("/transcripts", auth)).json()) as {count: number}
    expect(json.count).toBe(1)
    const text = await (await reviewApi.request("/transcripts?format=text", auth)).text()
    expect(text).toContain("heard:      我们今天下午要去参观博物馆")
    expect(text).toContain("would gloss:")
  })

  test("queries durable vocabulary candidates through operator authentication", async () => {
    setVocabularyScanner({
      stop() {},
      query: async () => [
        {
          v: 1,
          transcriptUser: "abc12345",
          status: "delivered",
          batch: {localDate: "2026-10-30", candidates: [{word: "斟酌"}]},
          deliveryAttempts: 1,
          lastDeliveryError: null,
          deliveredAt: "2026-10-31T00:00:00.000Z",
        },
      ],
    } as unknown as VocabularyScanner)
    expect((await reviewApi.request("/vocabulary-candidates?date=bad", auth)).status).toBe(400)
    const response = await reviewApi.request("/vocabulary-candidates?date=2026-10-30", auth)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      count: number
      batches: Array<{batch: {candidates: Array<{word: string}>}}>
    }
    expect(body.count).toBe(1)
    expect(body.batches[0]!.batch.candidates[0]!.word).toBe("斟酌")
    expect((await reviewApi.request("/vocabulary-candidates")).status).toBe(401)
    setVocabularyScanner(null)
  })

  test("parses relative, epoch and ISO times", () => {
    const now = 1_000_000_000_000
    expect(parseTime("24h", now)).toBe(now - 24 * 3_600_000)
    expect(parseTime("90m", now)).toBe(now - 90 * 60_000)
    expect(parseTime("7d", now)).toBe(now - 7 * 86_400_000)
    expect(parseTime("123456", now)).toBe(123456)
    expect(parseTime("2026-09-14T00:00:00Z", now)).toBe(Date.UTC(2026, 8, 14))
    expect(parseTime("yesterday-ish", now)).toBeUndefined()
    expect(parseTime(undefined, now)).toBeUndefined()
  })
})
