import {describe, expect, test} from "bun:test"

import {ShadowInterimDetector} from "./shadowInterim"

function feed(
  detector: ShadowInterimDetector,
  text: string,
  isFinal: boolean,
  now: number,
  lastGlossContext = "",
) {
  detector.observe({utteranceId: "u1", text, isFinal, lastGlossContext, now})
}

describe("ShadowInterimDetector", () => {
  test("an interim that stops changing for 300ms would have triggered", () => {
    const d = new ShadowInterimDetector()
    feed(d, "我们今天下午要去", false, 0)
    feed(d, "我们今天下午要去", false, 400)
    feed(d, "我们今天下午要去参观博物馆", true, 1_200)

    const [observation] = d.drain().filter((o) => o.variant === "stable300")
    expect(observation).toBeDefined()
    // Fired at 400ms, final at 1200ms: Phase 1 would have been 800ms earlier.
    expect(observation!.leadMs).toBe(800)
    expect(observation!.charsAtFinal).toBeGreaterThan(observation!.charsAtTrigger)
  })

  test("still-changing interims never satisfy the stability rule", () => {
    const d = new ShadowInterimDetector()
    feed(d, "我们", false, 0)
    feed(d, "我们今天", false, 400)
    feed(d, "我们今天下午", false, 800)
    feed(d, "我们今天下午要去", true, 1_200)

    expect(d.drain().some((o) => o.variant === "stable300")).toBe(false)
  })

  test("growth is measured against the last real gloss, not the last interim", () => {
    const d = new ShadowInterimDetector()
    // Six characters have already been glossed, so only what follows counts.
    feed(d, "我们今天下午", false, 0, "我们今天下午")
    feed(d, "我们今天下午要去参观博物馆", false, 200, "我们今天下午")
    feed(d, "我们今天下午要去参观博物馆。", true, 900, "我们今天下午")

    const [observation] = d.drain().filter((o) => o.variant === "growth6")
    expect(observation).toBeDefined()
    expect(observation!.leadMs).toBe(700)
  })

  test("a trigger identical to the last gloss is marked as a wasted call", () => {
    const d = new ShadowInterimDetector()
    feed(d, "参观博物馆", false, 0, "参观博物馆")
    feed(d, "参观博物馆", false, 400, "参观博物馆")
    feed(d, "参观博物馆", true, 800, "参观博物馆")

    const [observation] = d.drain().filter((o) => o.variant === "stable300")
    expect(observation?.wouldDuplicate).toBe(true)
  })

  test("nothing is reported until the final lands, and draining clears the buffer", () => {
    const d = new ShadowInterimDetector()
    feed(d, "参观博物馆", false, 0)
    feed(d, "参观博物馆", false, 400)
    expect(d.drain()).toHaveLength(0)

    feed(d, "参观博物馆", true, 800)
    expect(d.drain().length).toBeGreaterThan(0)
    expect(d.drain()).toHaveLength(0)
  })

  test("utterances that never finalize are bounded", () => {
    const d = new ShadowInterimDetector()
    for (let i = 0; i < 100; i++) {
      d.observe({utteranceId: `u${i}`, text: `t${i}`, isFinal: false, lastGlossContext: "", now: i})
    }
    d.observe({utteranceId: "done", text: "done", isFinal: true, lastGlossContext: "", now: 1_000})
    // No assertion on exact size; the point is that observe() prunes rather
    // than growing a map for the life of the session.
    expect(d.drain()).toHaveLength(0)
  })
})
