import {beforeEach, describe, expect, mock, test} from "bun:test"

import type {GeminiCallOptions, GeminiCallResult} from "./gemini"
import {knownRankFor} from "./frequency"

/** Every prompt the service built, so tests can assert on the contract. */
let calls: GeminiCallOptions[] = []
let reply = '{"words":[]}'

mock.module("./gemini", () => ({
  resolveModel: () => "test-model",
  resolveApiKey: () => "test-key",
  allowMockLlm: () => false,
  LlmServiceError: class extends Error {},
  generateJson: async (opts: GeminiCallOptions): Promise<GeminiCallResult> => {
    calls.push(opts)
    return {
      text: reply,
      geminiMs: 1,
      parseMs: 0,
      model: "test-model",
      truncated: false,
      usage: {totalTokens: 10},
    }
  },
}))

const {glossService} = await import("./gloss.service")

const ZH = "我们今天下午要去参观博物馆，然后在附近的餐厅吃晚饭。"
/** Carries 深远 (rank ~20675), so candidates survive even at high proficiency. */
const HARD_ZH = "这个政策的实施对经济发展产生了深远的影响。"

function request(proficiency: number, context = ZH) {
  return {
    conversationContext: context,
    inputLanguage: "Chinese",
    outputLanguage: "English",
    fluencyLevel: proficiency,
  }
}

beforeEach(() => {
  calls = []
  reply = '{"words":[]}'
})

describe("glossService", () => {
  test("returns empty words when context is blank", async () => {
    const result = await glossService.gloss({...request(33), conversationContext: ""})
    expect(result.words).toEqual([])
    expect(result.profiling.candidateCount).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("tells the model the learner's vocabulary size and pick budget", async () => {
    await glossService.gloss(request(10))
    expect(calls[0].user).toContain(`KNOWN=${knownRankFor(10)}`)
    expect(calls[0].user).toContain("MAX=3")

    calls = []
    await glossService.gloss(request(80, HARD_ZH))
    expect(calls[0].user).toContain(`KNOWN=${knownRankFor(80)}`)
    expect(calls[0].user).toContain("MAX=2")
  })

  test("sends candidates as word:rank", async () => {
    await glossService.gloss(request(10))
    const line = calls[0].user.split("\n").find((l) => l.startsWith("Candidates:"))!
    expect(line).toMatch(/博物馆:\d+/)
    expect(line).not.toContain(".")
  })

  test("reports the rank cut it used in profiling", async () => {
    const result = await glossService.gloss(request(70))
    expect(result.profiling.knownRank).toBe(knownRankFor(70))
  })

  test("skips the model entirely when nothing outranks the learner", async () => {
    const result = await glossService.gloss(request(100))
    expect(result.words).toEqual([])
    expect(result.profiling.candidateCount).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test("drops a word the learner is assumed to know", async () => {
    // 餐厅 is a real candidate for a beginner but not at proficiency 60, so the
    // model reshaping its pick must not reach the glasses.
    reply = '{"words":[{"word":"餐厅","translation":"restaurant"}]}'
    const result = await glossService.gloss(request(60))
    expect(result.words).toEqual([])
  })

  test("drops a word that was never a candidate", async () => {
    reply = '{"words":[{"word":"量子力学","translation":"quantum mechanics"}]}'
    const result = await glossService.gloss(request(10))
    expect(result.words).toEqual([])
  })

  test("honours the pick budget when the model over-answers", async () => {
    reply = JSON.stringify({
      words: [
        {word: "博物馆", translation: "museum"},
        {word: "参观", translation: "to visit"},
        {word: "餐厅", translation: "restaurant"},
        {word: "附近", translation: "nearby"},
      ],
    })
    const beginner = await glossService.gloss(request(10))
    expect(beginner.words).toHaveLength(3)

    const intermediate = await glossService.gloss(request(45))
    expect(intermediate.words.length).toBeLessThanOrEqual(2)
  })

  test("keeps accepted words and annotates them", async () => {
    reply = '{"words":[{"word":"博物馆","translation":"museum"}]}'
    const result = await glossService.gloss(request(10))
    expect(result.words).toHaveLength(1)
    expect(result.words[0].word).toContain("博物馆")
    expect(result.words[0].translation).toBe("museum")
  })
})
