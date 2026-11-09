import {describe, expect, test} from "bun:test"

import {forwardFocusWords} from "./prefilter"

describe("forwardFocusWords", () => {
  test("forwards exact ranked terms above the learner threshold", () => {
    expect(forwardFocusWords("我们去参观博物馆。", "zh", 1_000, "en")).toContain("博物馆")
  })

  test("does not require a lone Han fragment from an unknown compound", () => {
    expect(forwardFocusWords("这个模型需要预训练。", "zh", 5_000, "en")).not.toContain("预")
  })

  test("keeps a repeated unknown single-character word", () => {
    expect(forwardFocusWords("别怼我，怎么又怼我？", "zh", 5_000, "en")).toContain("怼")
  })
})
