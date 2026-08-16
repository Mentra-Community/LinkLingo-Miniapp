import {describe, expect, test} from "bun:test"

import {hasSentenceEnd, stripIncompleteLastWord, TranscriptBuffer} from "./TranscriptBuffer"

describe("stripIncompleteLastWord", () => {
  test("drops the trailing word when there is no punctuation", () => {
    expect(stripIncompleteLastWord("hello there wor")).toBe("hello there")
  })

  test("keeps the full sentence when it ends with punctuation", () => {
    expect(stripIncompleteLastWord("hello there.")).toBe("hello there.")
    expect(stripIncompleteLastWord("你好吗？")).toBe("你好吗？")
  })
})

describe("hasSentenceEnd", () => {
  test("detects western and CJK terminals", () => {
    expect(hasSentenceEnd("done.")).toBe(true)
    expect(hasSentenceEnd("好了。")).toBe(true)
    expect(hasSentenceEnd("not yet")).toBe(false)
  })
})

describe("TranscriptBuffer", () => {
  test("updates the current interim then finalizes it", () => {
    const buf = new TranscriptBuffer()
    buf.push("hel", false)
    buf.push("hello there", false)
    buf.push("hello there", true)
    expect(buf.list()).toHaveLength(1)
    expect(buf.list()[0]?.isFinal).toBe(true)
    expect(buf.context()).toBe("hello there")
  })

  test("starts a new utterance after a final", () => {
    const buf = new TranscriptBuffer()
    buf.push("one", true)
    buf.push("two", true)
    expect(buf.list()).toHaveLength(2)
    expect(buf.context()).toBe("one two")
  })
})
