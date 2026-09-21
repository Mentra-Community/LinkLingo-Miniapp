import {beforeEach, describe, expect, mock, test} from "bun:test"

import {DEFAULT_SETTINGS, type LinkLingoSettings} from "../shared/types"
import type {GlossAttempt} from "./glossTelemetry"

interface Captured {
  context: string
  attempt: GlossAttempt
}

const calls: Captured[] = []
let preconnects = 0

mock.module("./backend", () => ({
  requestGloss: async (_session: unknown, body: {conversationContext: string}, attempt: GlossAttempt) => {
    calls.push({context: body.conversationContext, attempt})
    return {ok: true, data: {words: [], profiling: {requestId: `rid-${calls.length}`}}}
  },
  requestUpgrade: async () => ({ok: false, message: "off"}),
  preconnect: () => {
    preconnects += 1
  },
  reportTranscript: () => {},
  requestFeedback: async () => ({ok: false, message: "off"}),
}))

const {GlossEngine} = await import("./GlossEngine")
const {TranscriptBuffer} = await import("./TranscriptBuffer")

function harness(overrides: Partial<LinkLingoSettings> = {}) {
  const buffer = new TranscriptBuffer()
  const engine = new GlossEngine({} as never, buffer, {
    onWords: () => {},
    onProfiling: () => {},
    onBackendError: () => {},
    onProcessing: () => {},
  })
  const settings: LinkLingoSettings = {
    ...DEFAULT_SETTINGS,
    sourceLanguage: "zh",
    targetLanguage: "en",
    wordUpgrades: false,
    ...overrides,
  }
  const say = (text: string, isFinal: boolean) => {
    const utterance = buffer.push(text, isFinal, "zh")
    return engine.consider(text, isFinal, settings, utterance.id)
  }
  return {engine, buffer, say}
}

beforeEach(() => {
  calls.length = 0
  preconnects = 0
})

describe("GlossEngine interim triggering", () => {
  test("an interim with enough new speech glosses at once, without waiting to settle", () => {
    const {say} = harness()
    say("我们今天下午要去参观", false)
    // Ten new characters clears the growth threshold, so there is nothing to
    // gain by waiting for the recognizer to stop revising.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.attempt.trigger).toBe("interim")
  })

  test("a shorter interim waits until it stops being revised", async () => {
    const {say} = harness()
    say("我们今天", false)
    await Bun.sleep(120)
    // Still under the growth threshold, and the revision restarts the clock.
    say("我们今天下", false)
    await Bun.sleep(120)
    expect(calls).toHaveLength(0)

    await Bun.sleep(280)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.attempt.trigger).toBe("interim")
  })

  test("the final after an interim gloss costs no second call", async () => {
    const {say} = harness()
    say("我们今天下午要去参观", false)
    expect(calls).toHaveLength(1)

    // The final lands while the interim call is still in flight, so it is
    // coalesced rather than refused outright; the duplicate check then drops
    // it when the in-flight call drains the queue.
    expect(say("我们今天下午要去参观", true)).toBe("queued_gloss")
    await Bun.sleep(50)
    expect(calls).toHaveLength(1)
  })

  test("the realised lead is measured against the final, matching the shadow metric", async () => {
    const {engine, say} = harness()
    say("我们今天下午要去参观", false)
    await Bun.sleep(120)
    say("我们今天下午要去参观博物馆。", true)

    const lead = engine.takeAsrLeadMs()
    expect(lead).toBeGreaterThanOrEqual(100)
    // Consumed once: the next transcript must not re-report it.
    expect(engine.takeAsrLeadMs()).toBeUndefined()
  })

  test("the toggle restores the final-only behaviour of 1.0.16", async () => {
    const {say} = harness({interimTrigger: false})
    say("我们今天下午要去参观", false)
    await Bun.sleep(400)
    expect(calls).toHaveLength(0)
  })

  test("an interim opens the connection before the gloss needs it", () => {
    const {say} = harness({interimTrigger: false})
    say("我们今天", false)
    expect(preconnects).toBe(1)
  })
})

describe("GlossEngine cooldown", () => {
  // Finals carry terminal punctuation here because the context builder drops a
  // trailing space-separated token, which would otherwise swallow the newest
  // utterance and make every pair look like a duplicate.
  const FIRST = "我们今天下午要去参观博物馆。"
  const SECOND = "然后在附近的餐厅吃晚饭。"

  test("eligibility is stamped before the wait, so the queue cost is visible", async () => {
    const {say} = harness({interimTrigger: false})
    say(FIRST, true)
    await Bun.sleep(10)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.attempt.queueReason).toBe("none")
    expect(Date.now() - calls[0]!.attempt.eligibleAt).toBeLessThan(400)
  })

  test("a small follow-up inside the cooldown is dropped, not delayed", async () => {
    const {say} = harness({interimTrigger: false})
    say(FIRST, true)
    await Bun.sleep(20)
    // Two new characters are not worth a call while the cooldown is running.
    expect(say("好。", true)).toBe("skipped_cooldown")
  })

  test("enough new speech bypasses the cooldown, because the words are in the new part", async () => {
    const {say} = harness({interimTrigger: false})
    say(FIRST, true)
    await Bun.sleep(20)
    expect(say(SECOND, true)).toBe("queued_gloss")
  })

  test("the bypass is about new content, not the clock, under either cooldown", async () => {
    const {say} = harness({interimTrigger: false, fastCooldown: false})
    say(FIRST, true)
    await Bun.sleep(20)
    expect(say(SECOND, true)).toBe("queued_gloss")
    await Bun.sleep(20)
    // A small follow-up is still suppressed, and for longer than it would be
    // under the short cooldown.
    expect(say("好。", true)).toBe("skipped_cooldown")
  })
})
