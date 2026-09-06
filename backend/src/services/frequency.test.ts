import {describe, expect, test} from "bun:test"

import {
  candidateWords,
  knownRankFor,
  lookupRank,
  MAX_KNOWN_RANK,
  MIN_KNOWN_RANK,
} from "./frequency"

const LADDER = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

/** Sentences with a known difficulty spread, used for the ladder invariants. */
const CORPUS: Array<{text: string; lang: string}> = [
  {text: "你好，请问洗手间在哪里？", lang: "zh"},
  {text: "我们今天下午要去参观博物馆，然后在附近的餐厅吃晚饭。", lang: "zh"},
  {text: "这个政策的实施对经济发展产生了深远的影响。", lang: "zh"},
  {text: "医生建议他每天锻炼身体，少吃油腻的食物。", lang: "zh"},
  {text: "由于天气恶劣，航班被迫延误了三个小时。", lang: "zh"},
  {text: "他在会议上提出了一个非常有创意的方案。", lang: "zh"},
  {text: "我妈妈做的饺子特别好吃。", lang: "zh"},
  {text: "科学家们正在研究如何减少温室气体的排放。", lang: "zh"},
  {text: "这家公司的股票昨天暴跌了百分之二十。", lang: "zh"},
  {text: "请把窗户关上，外面太冷了。", lang: "zh"},
  {text: "Can you pass me the salt? This soup needs more flavor.", lang: "en"},
  {text: "The committee postponed the vote because the amendment was ambiguous.", lang: "en"},
  {text: "My neighbor adopted a puppy from the shelter last weekend.", lang: "en"},
  {text: "The negotiations collapsed after both sides refused to compromise.", lang: "en"},
  {text: "I usually take the subway to work, but today I walked.", lang: "en"},
  {text: "Her thesis examines the socioeconomic ramifications of urbanization.", lang: "en"},
]

describe("knownRankFor", () => {
  test("is monotone across the whole slider", () => {
    for (let p = 0; p < 100; p++) {
      expect(knownRankFor(p + 1)).toBeGreaterThan(knownRankFor(p))
    }
  })

  test("stays inside the documented vocabulary range", () => {
    expect(knownRankFor(0)).toBe(MIN_KNOWN_RANK)
    expect(knownRankFor(100)).toBe(MAX_KNOWN_RANK)
    expect(knownRankFor(-50)).toBe(MIN_KNOWN_RANK)
    expect(knownRankFor(500)).toBe(MAX_KNOWN_RANK)
    expect(knownRankFor(Number.NaN)).toBe(knownRankFor(50))
  })

  test("hits the anchors the prompts and UI are written against", () => {
    expect(knownRankFor(33)).toBeGreaterThan(900)
    expect(knownRankFor(33)).toBeLessThan(1200)
    expect(knownRankFor(50)).toBeGreaterThan(1900)
    expect(knownRankFor(50)).toBeLessThan(2300)
    expect(knownRankFor(90)).toBeGreaterThan(9500)
    expect(knownRankFor(90)).toBeLessThan(11000)
  })
})

describe("candidateWords rank cut", () => {
  test("never offers a word the learner is assumed to know", () => {
    for (const {text, lang} of CORPUS) {
      for (const p of LADDER) {
        const knownRank = knownRankFor(p)
        for (const candidate of candidateWords(text, lang, [], knownRank)) {
          if (candidate.unknown) continue
          expect(candidate.rank).toBeGreaterThan(knownRank)
        }
      }
    }
  })

  test("candidates shrink monotonically as proficiency rises", () => {
    // The old pipeline returned *more* and *commoner* words at high fluency,
    // glossing 你好 for an advanced learner. This locks that out permanently.
    for (const {text, lang} of CORPUS) {
      for (let i = 0; i < LADDER.length; i++) {
        const lower = new Set(
          candidateWords(text, lang, [], knownRankFor(LADDER[i])).map((c) => c.word),
        )
        for (let j = i + 1; j < LADDER.length; j++) {
          const higher = candidateWords(text, lang, [], knownRankFor(LADDER[j]))
          for (const candidate of higher) {
            expect(lower.has(candidate.word)).toBe(true)
          }
        }
      }
    }
  })

  test("proficiency actually changes the output", () => {
    const text = "我们今天下午要去参观博物馆，然后在附近的餐厅吃晚饭。"
    const beginner = candidateWords(text, "zh", [], knownRankFor(10)).map((c) => c.word)
    const advanced = candidateWords(text, "zh", [], knownRankFor(90)).map((c) => c.word)
    expect(beginner).toContain("博物馆")
    expect(beginner.length).toBeGreaterThan(advanced.length)
    expect(advanced).toHaveLength(0)
  })

  test("returns nothing rather than falling back to common words", () => {
    const candidates = candidateWords("你好，请问洗手间在哪里？", "zh", [], knownRankFor(95))
    expect(candidates).toHaveLength(0)
  })

  test("sorts by gap so the rarest word leads", () => {
    const candidates = candidateWords(
      "Her thesis examines the socioeconomic ramifications of urbanization.",
      "en",
      [],
      knownRankFor(20),
    )
    const ranks = candidates.filter((c) => !c.unknown).map((c) => c.rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
  })

  test("excludes recent items", () => {
    const candidates = candidateWords(
      "photosynthesis chlorophyll",
      "en",
      ["photosynthesis"],
      knownRankFor(50),
    )
    expect(candidates.some((c) => c.word === "photosynthesis")).toBe(false)
  })

  test("drops function words, numerals and segmentation debris", () => {
    const text = "这家公司的股票昨天暴跌了百分之二十，外面太冷了，少吃油腻的食物。"
    const words = candidateWords(text, "zh", [], knownRankFor(30)).map((c) => c.word)
    expect(words).toContain("暴跌")
    // A number is never vocabulary, however rare the digits make it look.
    expect(words).not.toContain("百分之二十")
    // 少吃 is jieba splitting mid-phrase, not a word anyone needs glossed.
    expect(words).not.toContain("少吃")
    expect(words).not.toContain("的")
    expect(words).not.toContain("这家")
    // 少 (rank 1170) is a modifier, not vocabulary worth a HUD line.
    expect(words).not.toContain("少")

    // 太冷 is listed at rank 11642 but decomposes to 冷 (1245), so it must fall
    // out of the candidate set as soon as the learner is past that vocabulary.
    const mid = candidateWords(text, "zh", [], knownRankFor(50)).map((c) => c.word)
    expect(mid).not.toContain("太冷")
  })
})

describe("single-character hanzi", () => {
  test("keeps rare content characters but drops modifiers", () => {
    const salt = candidateWords("请给我盐。", "zh", [], knownRankFor(20)).map((c) => c.word)
    expect(salt).toContain("盐")
    for (const text of ["请你慢一点。", "外面很冷。", "他吃得很少。"]) {
      const words = candidateWords(text, "zh", [], knownRankFor(20)).map((c) => c.word)
      expect(words.filter((w) => w.length === 1)).toEqual([])
    }
  })
})

describe("lookupRank", () => {
  test("demotes compounds a learner can decode from their parts", () => {
    // 今天下午 is listed at rank 4174 but is just 今天 + 下午.
    expect(lookupRank("今天下午", "zh")!).toBeLessThan(2000)
    expect(lookupRank("太冷", "zh")!).toBeLessThan(2000)
    // A genuine vocabulary item must survive: 馆 alone is rare.
    expect(lookupRank("博物馆", "zh")!).toBeGreaterThan(3000)
    expect(lookupRank("洗手间", "zh")!).toBeGreaterThan(3000)
  })

  test("recovers English inflections that miss the frequency list", () => {
    expect(lookupRank("walked", "en")).not.toBeNull()
    expect(lookupRank("usually", "en")).not.toBeNull()
    expect(lookupRank("negotiations", "en")).not.toBeNull()
  })

  test("reports nothing for words no dictionary knows", () => {
    expect(lookupRank("zzzqqxwv", "en")).toBeNull()
  })
})

describe("dictionary sanity", () => {
  test("Chinese ranks are computed without the Latin contamination", () => {
    // The raw list ranks 洗手间 at 3690 because ~480 Latin tokens sit above it.
    // Loading must drop those, which pulls it back to its real rank.
    expect(lookupRank("洗手间", "zh")).toBeLessThan(3500)
    expect(lookupRank("锻炼", "zh")).toBeLessThan(7000)
  })

  test("beginner vocabulary ranks below the beginner cut", () => {
    for (const word of ["谢谢", "朋友", "医生", "学校"]) {
      expect(lookupRank(word, "zh")!).toBeLessThan(800)
    }
  })

  test("advanced vocabulary ranks well above it", () => {
    for (const word of ["深远", "实施", "政策", "暴跌", "排放"]) {
      expect(lookupRank(word, "zh")!).toBeGreaterThan(2500)
    }
  })
})
