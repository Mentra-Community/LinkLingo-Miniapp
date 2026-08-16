import {describe, expect, test} from "bun:test"

import {candidateWords, fluencyThreshold, rankWords} from "./frequency"

describe("fluencyThreshold", () => {
  test("scales with proficiency", () => {
    expect(fluencyThreshold(10)).toBe(0.5)
    expect(fluencyThreshold(40)).toBe(2)
    expect(fluencyThreshold(60)).toBe(5)
    expect(fluencyThreshold(90)).toBe(10)
  })
})

describe("rankWords", () => {
  test("drops very common English words and short tokens", () => {
    const ranks = rankWords("the a it hello talking fruitstand", "en")
    expect(ranks.the).toBeUndefined()
    expect(ranks.it).toBeUndefined()
  })

  test("candidateWords excludes recent items", () => {
    const candidates = candidateWords("photosynthesis chlorophyll", "en", ["photosynthesis"], 0)
    expect(candidates.some((c) => c.word === "photosynthesis")).toBe(false)
  })
})
