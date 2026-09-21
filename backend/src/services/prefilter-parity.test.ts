/**
 * The on-device prefilter decides not to call the backend. If it is ever
 * stricter than the backend's own candidate selection, a gloss the learner
 * should have seen silently disappears — and unlike a slow gloss, nothing in
 * the tape would show it. So the contract is one-directional and checked here
 * against the same labelled corpus the gloss eval uses:
 *
 *   candidateWords(...) is non-empty  =>  hasRareToken(...) is true
 *
 * The converse is allowed. The phone calling when the backend finds nothing
 * only costs the round trip that was being made anyway.
 */

import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"

import {hasRareToken} from "../../../miniapp/src/background/prefilter"
import {candidateWords, knownRankFor} from "./frequency"

interface Corpus {
  samples: Array<{text: string; inputLanguage: string; outputLanguage: string}>
}

const corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "../../test/fixtures/gloss-corpus.json"), "utf8"),
) as Corpus

const LEVELS = [0, 10, 33, 50, 67, 90, 100]

describe("prefilter parity with backend candidate selection", () => {
  test("never suppresses a call the backend would have found candidates for", () => {
    const missed: string[] = []
    for (const sample of corpus.samples) {
      for (const proficiency of LEVELS) {
        const knownRank = knownRankFor(proficiency)
        const candidates = candidateWords(
          sample.text,
          sample.inputLanguage,
          [],
          knownRank,
          sample.outputLanguage,
        )
        if (candidates.length === 0) continue
        const phoneWouldCall = hasRareToken(
          sample.text,
          sample.inputLanguage,
          knownRank,
          sample.outputLanguage,
        )
        if (!phoneWouldCall) {
          missed.push(`p=${proficiency} "${sample.text}" (backend wanted ${candidates[0]!.word})`)
        }
      }
    }
    expect(missed).toEqual([])
  })

  test("suppresses at least some calls, or it is not worth the bundle weight", () => {
    let suppressed = 0
    let total = 0
    for (const sample of corpus.samples) {
      for (const proficiency of LEVELS) {
        total += 1
        const knownRank = knownRankFor(proficiency)
        if (!hasRareToken(sample.text, sample.inputLanguage, knownRank, sample.outputLanguage)) {
          suppressed += 1
        }
      }
    }
    // The corpus is deliberately dense in rare words, so this is a floor, not
    // a prediction of what real speech will save.
    expect(suppressed).toBeGreaterThan(0)
    expect(suppressed).toBeLessThan(total)
  })

  test("an unsupported input language always calls rather than guessing", () => {
    expect(hasRareToken("Bonjour tout le monde", "fr", 1000, "en")).toBe(true)
  })

  test("empty speech is not a call", () => {
    expect(hasRareToken("   ", "zh", 1000, "en")).toBe(false)
  })
})
