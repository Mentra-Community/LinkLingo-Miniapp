import {describe, expect, test} from "bun:test"

import {shouldQueueGloss} from "./GlossEngine"

describe("shouldQueueGloss", () => {
  test("skips a one- or two-character filler when the buffer is still empty", () => {
    expect(shouldQueueGloss({text: "嗯", isFinal: true, context: "嗯"})).toBe(false)
    expect(shouldQueueGloss({text: "好的", isFinal: true, context: "好的"})).toBe(false)
  })

  test("glosses a short Chinese phrase on its own", () => {
    expect(shouldQueueGloss({text: "我们去吃饭", isFinal: true, context: "我们去吃饭"})).toBe(true)
  })

  test("glosses a filler once the buffer already holds a phrase", () => {
    expect(shouldQueueGloss({text: "嗯", isFinal: true, context: "然后那个功能不行了 嗯"})).toBe(true)
  })

  test("does not fire on a short interim without a sentence end", () => {
    expect(shouldQueueGloss({text: "我们去吃饭", isFinal: false, context: "我们去吃饭"})).toBe(false)
  })

  test("fires on an interim that already ends a sentence", () => {
    expect(shouldQueueGloss({text: "我们去吃饭。然后", isFinal: false, context: "我们去吃饭。然后"})).toBe(true)
  })
})
