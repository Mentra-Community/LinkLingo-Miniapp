import {afterAll, beforeAll, describe, expect, test} from "bun:test"

import type {LearningEvent} from "../shared/mandarin-contract"
import {DEFAULT_SETTINGS, type LinkLingoSettings} from "../shared/types"
import {LinkLingoController} from "./LinkLingoController"
import {LearningCapture, type EnqueueInput, type SendResult} from "./learningCapture"

/**
 * Exercises the capture hook through the real controller handlers, with a fake
 * session. The real backend module is used (no module mocking, so this file
 * cannot disturb other suites); its network calls fail harmlessly against the
 * stubbed fetch / auth.
 */

const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async () => new Response("{}", {status: 200})) as unknown as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const noop = () => Promise.resolve()

function fakeSession() {
  const store = new Map<string, string>()
  const sent: Array<{channel: string; payload: unknown}> = []
  const session = {
    storage: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
      keys: async () => [...store.keys()],
    },
    display: new Proxy({}, {get: () => noop}),
    ui: {
      send: (channel: string, payload: unknown) => void sent.push({channel, payload}),
      on: () => {},
      onOpen: () => {},
    },
    auth: {
      fetch: async () => {
        throw new Error("offline")
      },
      onUpdate: () => () => {},
    },
  }
  return {session, sent, store}
}

async function setup(settings: Partial<LinkLingoSettings> = {}) {
  const {session, sent, store} = fakeSession()
  const delivered: LearningEvent[] = []
  const capture = new LearningCapture({
    storage: {
      get: (k) => session.storage.get(k),
      set: (k, v) => session.storage.set(k, v),
      delete: (k) => session.storage.delete(k),
      keys: () => session.storage.keys(),
    },
    send: async (events): Promise<SendResult> => {
      delivered.push(...events)
      return {kind: "ok", accepted: events.map((e) => e.eventId), rejected: []}
    },
    clientVersion: "test",
    clientBuildId: "test",
    // Never let a debounce timer fire during these tests; delivery is covered elsewhere.
    timers: {set: () => 0, clear: () => {}},
  })
  await capture.init()
  capture.setEnabled(true)
  capture.setConnected(true)
  capture.startSession()
  const controller = new LinkLingoController(session as never, {learning: capture})
  const internals = controller as unknown as {
    settings: LinkLingoSettings
    handleTranscription(data: {text: string; isFinal: boolean; language?: string}): void
    handleTranslation(data: {text: string; originalText?: string; isFinal: boolean; sourceLanguage?: string}): void
    recordTranscript(text: string, lang: string | undefined, disposition: string, utteranceId?: string): void
    saveForLater(text: string, source: "voice" | "typed", requestId?: string): Promise<void>
  }
  internals.settings = {...DEFAULT_SETTINGS, learningCapture: true, ...settings}
  return {controller, internals, capture, sent, store, delivered}
}

/** Lets fire-and-forget captures land, then delivers whatever was queued. */
async function queued(capture: LearningCapture): Promise<void> {
  await new Promise((r) => setTimeout(r, 10))
  await capture.drain({force: true})
}

describe("controller learning hook", () => {
  test("a simple sentence with nothing to gloss is captured", async () => {
    const {internals, capture, delivered} = await setup()
    internals.handleTranscription({text: "我们去吃饭吧", isFinal: true, language: "zh-CN"})
    await queued(capture)
    expect(delivered.map((e) => e.text)).toEqual(["我们去吃饭吧"])
    expect(delivered[0]).toMatchObject({inputLanguage: "zh", outputLanguage: "en", detectedLanguage: "zh-CN"})
  })

  test("interims are not captured, only finals", async () => {
    const {internals, capture, delivered} = await setup()
    internals.handleTranscription({text: "我们去吃", isFinal: false, language: "zh-CN"})
    internals.handleTranscription({text: "我们去吃饭吧", isFinal: true, language: "zh-CN"})
    await queued(capture)
    expect(delivered).toHaveLength(1)
  })

  test("an English fallback in a Chinese conversation is captured", async () => {
    const {internals, capture, delivered} = await setup()
    internals.handleTranscription({text: "I just need a coffee", isFinal: true, language: "en-US"})
    await queued(capture)
    expect(delivered.map((e) => e.text)).toEqual(["I just need a coffee"])
    // The engine may treat this as a reverse gloss (English fallback) or a skip; either way it is kept.
    expect(["gloss", "reverse"]).toContain(delivered[0]!.mode)
  })

  test("a loose spoken save command stores only the requested sentence", async () => {
    const {internals, capture, delivered} = await setup()
    internals.handleTranscription({
      text: "Hey Lingo, could you keep this phrase: I need to reschedule the meeting.",
      isFinal: true,
      language: "en-US",
    })
    await queued(capture)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      text: "I need to reschedule the meeting.",
      mode: "reverse",
      disposition: "save_for_later",
    })
  })

  test("the phone fallback is explicit and works while passive capture is off", async () => {
    const {internals, capture, delivered, sent} = await setup({learningCapture: false})
    capture.setEnabled(false)
    await internals.saveForLater("I need more time to decide.", "typed", "save-1")
    await queued(capture)
    expect(delivered[0]).toMatchObject({
      text: "I need more time to decide.",
      disposition: "save_for_later",
    })
    expect(sent).toContainEqual({
      channel: "link:save-for-later-result",
      payload: {
        requestId: "save-1",
        ok: true,
        message: "Saved for later. It will appear in Mandarin after analysis.",
      },
    })
  })

  test("translation mode captures the recognized original, untrimmed", async () => {
    const {internals, capture, delivered} = await setup({mode: "translation"})
    internals.handleTranslation({
      text: "Where is the station?",
      originalText: " 车站在哪里？ ",
      isFinal: true,
      sourceLanguage: "zh-CN",
    })
    await queued(capture)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({text: " 车站在哪里？ ", mode: "translation", disposition: "translation_mode"})
  })

  test("reverse and heard dispositions map to their own modes", async () => {
    const {internals, capture, delivered} = await setup()
    internals.recordTranscript("那个 museum 很好看", "zh-CN", "reverse_gloss", "utt-r")
    internals.recordTranscript("嗯嗯", "zh-CN", "heard", "utt-h")
    internals.recordTranscript("你好吗", "zh-CN", "queued_gloss", "utt-g")
    await queued(capture)
    expect(delivered.map((e) => [e.mode, e.disposition, e.utteranceId])).toEqual([
      ["reverse", "reverse_gloss", "utt-r"],
      ["heard", "heard", "utt-h"],
      ["gloss", "queued_gloss", "utt-g"],
    ])
  })

  test("is a no-op when the setting is off", async () => {
    const {internals, capture, delivered} = await setup({learningCapture: false})
    internals.handleTranscription({text: "我们去吃饭吧", isFinal: true, language: "zh-CN"})
    await queued(capture)
    expect(delivered).toHaveLength(0)
    expect(capture.status().pending).toBe(0)
  })

  test("is a no-op until the backend reports a connection", async () => {
    const {internals, capture, delivered} = await setup()
    capture.setConnected(false)
    internals.handleTranscription({text: "我们去吃饭吧", isFinal: true, language: "zh-CN"})
    await queued(capture)
    expect(delivered).toHaveLength(0)
    expect(capture.status().pending).toBe(0)
  })

  test("captions still render when capture throws or rejects", async () => {
    const {session, sent} = fakeSession()
    const boom = {
      enqueue: (_input: EnqueueInput) => {
        throw new Error("sync explosion")
      },
      setListening: () => {},
      startSession: () => "x",
      setEnabled: () => {},
      setConnected: () => {},
      onChange: () => () => {},
      status: () => ({
        state: "paused",
        pending: 0,
        pendingBytes: 0,
        gaps: [],
        quarantined: 0,
        lastAcceptedAt: null,
        lastError: null,
      }),
    }
    const rejecting = {...boom, enqueue: () => Promise.reject(new Error("async explosion"))}
    for (const stub of [boom, rejecting]) {
      sent.length = 0
      const controller = new LinkLingoController(session as never, {learning: stub as never})
      const internals = controller as unknown as {
        settings: LinkLingoSettings
        handleTranscription(data: {text: string; isFinal: boolean; language?: string}): void
      }
      internals.settings = {...DEFAULT_SETTINGS, learningCapture: true}
      expect(() =>
        internals.handleTranscription({text: "我们去吃饭吧", isFinal: true, language: "zh-CN"}),
      ).not.toThrow()
      await new Promise((r) => setTimeout(r, 10))
      expect(sent.some((m) => m.channel === "link:caption")).toBe(true)
    }
  })
})
