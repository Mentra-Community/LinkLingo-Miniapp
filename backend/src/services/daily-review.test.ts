import {describe, expect, test} from "bun:test"

import type {TranscriptDisposition} from "../shared-types"
import {DailyReviewer, sanitizeItems} from "./daily-review"
import {HistoryStore} from "./history-store"
import type {TranscriptEntry} from "./transcript-log"

const HOUR = 3_600_000

function heard(user: string, at: number, text: string, disposition: TranscriptDisposition = "queued_gloss"): TranscriptEntry {
  return {
    id: `${at}-${text}`,
    at,
    user,
    text,
    inputLanguage: "zh",
    outputLanguage: "en",
    proficiency: 33,
    knownRank: 1000,
    mode: "gloss",
    disposition,
    wouldGloss: [],
  }
}

function setup(transcripts: TranscriptEntry[], reply = '{"items":[]}') {
  const history = new HistoryStore(null, "test")
  const prompts: string[] = []
  const reviewer = new DailyReviewer({
    history,
    transcripts: () => transcripts,
    generate: async (opts) => {
      prompts.push(opts.user)
      return {text: reply}
    },
    enabled: () => true,
  })
  return {history, reviewer, prompts}
}

const now = Date.now()
const day = (user = "u1") => Array.from({length: 6}, (_, i) => heard(user, now - (i + 1) * HOUR, `我昨天去了一个博物馆${i}`))

describe("daily review", () => {
  test("keeps only short excerpts, never the transcript", async () => {
    const reply = JSON.stringify({
      items: [
        {said: "我昨天去了一个博物馆看了很多很多很多的东西", better: "我昨天去了一家博物馆", rule: "Use 家 for museums.", confidence: "high"},
        {said: "same", better: "same", rule: "echo", confidence: "high"},
      ],
    })
    const {history, reviewer} = setup(day(), reply)
    expect(await reviewer.runOnce(now)).toBe(1)
    const events = await history.events("u1", now - HOUR, now + HOUR, now)
    const review = events.find((e) => e.kind === "review")
    expect(review?.kind === "review" && review.items).toEqual([
      {said: "我昨天去了一个博物馆看了很多很多很多的东", better: "我昨天去了一家博物馆", rule: "Use 家 for museums.", confidence: "high"},
    ])
    expect(review?.kind === "review" && [...review.items[0]!.said].length).toBe(20)
  })

  test("a user reviewed in the last 20h is not reviewed again, even by a new pod", async () => {
    const {history, reviewer, prompts} = setup(day())
    await reviewer.runOnce(now)
    expect(await reviewer.runOnce(now + HOUR)).toBe(0)
    const fresh = new DailyReviewer({history, transcripts: () => day(), generate: async () => ({text: '{"items":[]}'}), enabled: () => true})
    expect(await fresh.runOnce(now + 2 * HOUR)).toBe(0)
    expect(prompts).toHaveLength(1)
  })

  test("stores nothing when there is not enough learner speech", async () => {
    const english = Array.from({length: 10}, (_, i) => heard("u1", now - HOUR, `I said ${i}`, "skipped_language"))
    const {history, reviewer, prompts} = setup([...english, ...day().slice(0, 2)])
    expect(await reviewer.runOnce(now)).toBe(0)
    expect(prompts).toHaveLength(0)
    expect(await history.events("u1", now - 2 * HOUR, now + HOUR, now)).toEqual([])
  })

  test("each user is reviewed from their own speech only", async () => {
    const {reviewer, prompts} = setup([...day("u1"), ...day("u2").map((e, i) => ({...e, text: `别人说的话${i}`}))])
    expect(await reviewer.runOnce(now)).toBe(2)
    const other = prompts.find((p) => p.includes("别人说的话"))!
    expect(other).not.toContain("博物馆")
    expect(prompts.find((p) => p.includes("博物馆"))).not.toContain("别人说的话")
  })

  test("unknown confidence falls back to low and malformed output stores nothing", () => {
    expect(sanitizeItems({items: [{said: "一个人们", better: "人们", rule: "x", confidence: "sure"}]})[0]!.confidence).toBe("low")
    expect(sanitizeItems({nope: true})).toEqual([])
  })
})
