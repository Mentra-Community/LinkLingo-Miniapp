import {describe, expect, test} from "bun:test"

import {glossService} from "./gloss.service"

describe("glossService", () => {
  test("returns empty words when context is blank", async () => {
    const result = await glossService.gloss({
      conversationContext: "",
      inputLanguage: "en",
      outputLanguage: "zh",
      fluencyLevel: 33,
    })
    expect(result.words).toEqual([])
    expect(result.profiling.candidateCount).toBe(0)
  })
})
