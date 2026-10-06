import {beforeEach, describe, expect, mock, test} from "bun:test"

import {DEFAULT_SETTINGS, type GlossedWord, type LinkLingoSettings} from "../shared/types"

interface Sent {
  conversationContext: string
  inputLanguage: string
  outputLanguage: string
  purpose?: string
  knownRank?: number
  maxWords?: number
}

const sent: Sent[] = []
let reply: Array<{word: string; translation: string}> = []
let release: (() => void) | null = null
let hold = false

mock.module("./backend", () => ({
  requestGloss: async (_session: unknown, body: Sent) => {
    sent.push(body)
    if (hold) await new Promise<void>((resolve) => (release = resolve))
    return {ok: true, data: {words: reply, profiling: {}}}
  },
  requestUpgrade: async () => ({ok: false, message: "off"}),
  preconnect: () => {},
  reportTranscript: () => {},
  requestFeedback: async () => ({ok: false, message: "off"}),
}))

const {ReverseGlosser, fallbackWords, reverseApplies} = await import("./ReverseGlosser")
const {GlossEngine} = await import("./GlossEngine")
const {TranscriptBuffer} = await import("./TranscriptBuffer")

const zhEn: LinkLingoSettings = {...DEFAULT_SETTINGS, sourceLanguage: "zh", targetLanguage: "en"}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  sent.length = 0
  reply = []
  release = null
  hold = false
})

describe("fallback words", () => {
  test("pulls English out of Chinese even when the recognizer glues it to the hanzi", () => {
    expect(fallbackWords("我想去那个museum看看", zhEn)).toEqual(["museum"])
    expect(fallbackWords("我想去那个 museum 看看 exhibition", zhEn).sort()).toEqual(["exhibition", "museum"])
  })

  test("skips the most common English at the chosen cut", () => {
    expect(fallbackWords("I want to go there", zhEn)).toEqual([])
    expect(fallbackWords("我们 go 吧", zhEn)).toEqual([])
    // A tighter cut keeps more words, a looser one drops them.
    expect(fallbackWords("那个 problem", {...zhEn, reverseKnownRank: 300})).toEqual(["problem"])
    expect(fallbackWords("那个 problem", {...zhEn, reverseKnownRank: 2000})).toEqual([])
  })

  test("only applies to pairs with different scripts, and not in translate mode", () => {
    expect(reverseApplies(zhEn)).toBe(true)
    expect(reverseApplies({...zhEn, reverseGloss: false})).toBe(false)
    expect(reverseApplies({...zhEn, mode: "translation"})).toBe(false)
    expect(reverseApplies({...zhEn, sourceLanguage: "es"})).toBe(false)
  })
})

describe("ReverseGlosser", () => {
  test("sends the swapped pair with its own cut and budget, and marks the rows", async () => {
    reply = [{word: "museum", translation: "博物馆 (bó wù guǎn)"}]
    const shown: GlossedWord[] = []
    const reverse = new ReverseGlosser({} as never, (words) => shown.push(...words))
    expect(reverse.consider("我想去那个 museum", zhEn)).toBe(true)
    await tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({inputLanguage: "en", outputLanguage: "zh", purpose: "reverse", knownRank: 500, maxWords: 2})
    expect(shown.map((w) => [w.word, w.direction])).toEqual([["museum", "reverse"]])
  })

  test("a word just shown is not sent again inside the hold-off", async () => {
    reply = [{word: "museum", translation: "博物馆"}]
    const reverse = new ReverseGlosser({} as never, () => {})
    reverse.consider("那个 museum", zhEn)
    await tick()
    expect(reverse.consider("还是那个 museum", zhEn)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  test("one request in flight; the newest fallback runs next and older ones are dropped", async () => {
    hold = true
    const reverse = new ReverseGlosser({} as never, () => {})
    reverse.consider("那个 museum", zhEn)
    reverse.consider("那个 exhibition", zhEn)
    reverse.consider("那个 ceremony", zhEn)
    await tick()
    expect(sent).toHaveLength(1)
    hold = false
    release?.()
    await tick()
    await tick()
    expect(sent.map((s) => s.conversationContext)).toEqual(["那个 museum", "那个 ceremony"])
  })
})

describe("GlossEngine routing", () => {
  function harness(settings = zhEn) {
    const buffer = new TranscriptBuffer()
    const shown: GlossedWord[] = []
    const engine = new GlossEngine({} as never, buffer, {
      onWords: (words) => shown.push(...words),
      onProfiling: () => {},
      onBackendError: () => {},
      onProcessing: () => {},
    })
    const say = (text: string) => engine.consider(text, true, settings, buffer.push(text, true, "zh").id)
    return {say, shown}
  }

  test("an English sentence in a Chinese session is glossed back instead of skipped", async () => {
    const {say} = harness()
    expect(say("I need to find the embassy.")).toBe("reverse_gloss")
    await tick()
    expect(sent.some((s) => s.purpose === "reverse" && s.inputLanguage === "en")).toBe(true)
  })

  test("with the toggle off, English is skipped exactly as before", () => {
    const {say} = harness({...zhEn, reverseGloss: false})
    expect(say("I need to find the embassy.")).toBe("skipped_language")
    expect(sent).toHaveLength(0)
  })

  test("common English alone still counts as skipped language", () => {
    const {say} = harness()
    expect(say("I want to go there.")).toBe("skipped_language")
    expect(sent).toHaveLength(0)
  })

  test("a mixed sentence gets both directions", async () => {
    const {say} = harness()
    say("我们下午去参观那个 museum。")
    await tick()
    const purposes = sent.map((s) => s.purpose ?? "forward").sort()
    expect(purposes).toEqual(["forward", "reverse"])
  })
})
