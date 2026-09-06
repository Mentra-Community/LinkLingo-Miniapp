import {describe, expect, test} from "bun:test"
import {readFileSync} from "fs"
import {join} from "path"

import {candidateWords, knownRankFor, lookupRank} from "./frequency"

type Tier = "beginner" | "intermediate" | "advanced"

interface Corpus {
  anchors: Record<Tier, number>
  neverGloss: string[]
  samples: Array<{
    text: string
    inputLanguage: string
    outputLanguage: string
    expect: Record<Tier, string[]>
  }>
}

const corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "../../test/fixtures/gloss-corpus.json"), "utf8"),
) as Corpus

const tiers = Object.keys(corpus.anchors) as Tier[]

/**
 * The live eval measures how often the model picks the labelled word, which is
 * only meaningful if the pipeline can offer it in the first place. These checks
 * are what stop a fixture from quietly reporting an unreachable target as a
 * model failure.
 */
describe("gloss corpus fixture", () => {
  test("every expected word is a candidate at its tier", () => {
    for (const sample of corpus.samples) {
      for (const tier of tiers) {
        const knownRank = knownRankFor(corpus.anchors[tier])
        const candidates = new Set(
          candidateWords(sample.text, sample.inputLanguage, [], knownRank).map((c) => c.word),
        )
        for (const word of sample.expect[tier]) {
          expect(
            candidates.has(word) || candidates.has(word.toLowerCase()),
            `${tier}: "${word}" is not a candidate for "${sample.text}"`,
          ).toBe(true)
        }
      }
    }
  })

  test("no expected word is one the tier already knows", () => {
    for (const sample of corpus.samples) {
      for (const tier of tiers) {
        const knownRank = knownRankFor(corpus.anchors[tier])
        for (const word of sample.expect[tier]) {
          const rank = lookupRank(word, sample.inputLanguage)
          if (rank == null) continue
          expect(rank, `${tier}: "${word}" ranks inside the known vocabulary`).toBeGreaterThan(
            knownRank,
          )
        }
      }
    }
  })

  test("expectations shrink as proficiency rises", () => {
    for (const sample of corpus.samples) {
      expect(sample.expect.beginner.length).toBeGreaterThanOrEqual(sample.expect.advanced.length)
    }
  })

  test("candidate selection never offers a never-gloss token", () => {
    const banned = new Set(corpus.neverGloss.map((w) => w.toLowerCase()))
    for (const sample of corpus.samples) {
      for (const tier of tiers) {
        const words = candidateWords(
          sample.text,
          sample.inputLanguage,
          [],
          knownRankFor(corpus.anchors[tier]),
        )
        for (const candidate of words) {
          expect(
            banned.has(candidate.word.toLowerCase()),
            `${tier}: "${candidate.word}" should never be a candidate`,
          ).toBe(false)
        }
      }
    }
  })
})
