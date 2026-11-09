import {describe, expect, test} from "bun:test"

import type {VocabularyCandidate} from "./vocabulary-contract"
import {LearnerVocabulary} from "./learner-vocabulary"

function candidate(word: string, overrides: Partial<VocabularyCandidate> = {}): VocabularyCandidate {
  return {
    word,
    pinyin: "xuán xué",
    english: "mystical guesswork",
    corpusRank: null,
    totalAppearances: 1,
    distinctSessions: 1,
    contexts: [{text: `这个说法有点${word}`, capturedAt: "2026-11-08T00:00:00.000Z", sessionId: "session-1"}],
    reasons: ["Hard term"],
    confidence: "high",
    ...overrides,
  }
}

describe("LearnerVocabulary", () => {
  test("matches medium and high confidence terms in live context", () => {
    const vocabulary = new LearnerVocabulary()
    vocabulary.remember("user", [candidate("玄学"), candidate("品控", {confidence: "medium"})])

    expect(vocabulary.match("user", "这有点玄学，品控也不稳定", 10_000, [], 3).map((term) => term.word)).toEqual([
      "玄学",
      "品控",
    ])
  })

  test("ignores low confidence, known-rank and recently shown terms", () => {
    const vocabulary = new LearnerVocabulary()
    vocabulary.remember("user", [
      candidate("玄学", {confidence: "low"}),
      candidate("对齐", {corpusRank: 500}),
      candidate("品控"),
    ])

    expect(vocabulary.match("user", "玄学、对齐和品控", 1_000, ["品控"], 3)).toEqual([])
  })

  test("prioritizes terms that appeared more often", () => {
    const vocabulary = new LearnerVocabulary()
    vocabulary.remember("user", [candidate("玄学", {totalAppearances: 2}), candidate("品控", {totalAppearances: 8})])

    expect(vocabulary.match("user", "玄学和品控", 10_000, [], 1)[0]?.word).toBe("品控")
  })
})
