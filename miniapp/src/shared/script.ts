/**
 * Writing-system check for the phone side of the language guard. Mirrors
 * `backend/src/services/script.ts`; the backend filters candidates the same
 * way, this copy just saves the round trip when a whole utterance is in the
 * learner's own language (the speaker switched to English while the glasses
 * were set to hear Chinese).
 */

export type Script = "han" | "latin" | "cyrillic" | "arabic" | "hangul" | "unknown"

const LANGUAGE_SCRIPTS: Record<string, Script> = {
  zh: "han",
  en: "latin",
  es: "latin",
  fr: "latin",
  de: "latin",
  it: "latin",
  pt: "latin",
  nl: "latin",
  tr: "latin",
  ru: "cyrillic",
  ar: "arabic",
  ko: "hangul",
}

/**
 * Per-character weight: a hanzi or hangul block is a syllable, a letter about
 * a third of one, so a Chinese sentence with one English loanword still reads
 * as Chinese.
 */
const COUNTERS: Array<[Script, RegExp, number]> = [
  ["han", /[\u4e00-\u9fff]/g, 3],
  ["hangul", /[\uac00-\ud7af\u1100-\u11ff]/g, 3],
  ["cyrillic", /[\u0400-\u04ff]/g, 1],
  ["arabic", /[\u0600-\u06ff]/g, 1],
  ["latin", /[A-Za-z\u00c0-\u024f]/g, 1],
]

const ANNOTATION = /\([^)]*\)/g

export function scriptOfLanguage(language: string): Script {
  const bare = language.toLowerCase().split(/[-_]/)[0] ?? language
  return LANGUAGE_SCRIPTS[bare] ?? "unknown"
}

/** Dominant script by weighted count, ignoring parenthesised annotation; digits and punctuation alone are "unknown". */
export function scriptOfText(text: string): Script {
  const body = text.replace(ANNOTATION, "")
  let best: Script = "unknown"
  let bestScore = 0
  for (const [script, pattern, weight] of COUNTERS) {
    const score = (body.match(pattern)?.length ?? 0) * weight
    if (score > bestScore) {
      best = script
      bestScore = score
    }
  }
  return best
}

/**
 * Whether an utterance is worth glossing for a learner of `inputLanguage` who
 * reads `outputLanguage`. Only decides when the two languages differ in script;
 * for English→Spanish every utterance passes.
 */
export function utteranceInInputLanguage(text: string, inputLanguage: string, outputLanguage: string): boolean {
  const input = scriptOfLanguage(inputLanguage)
  const output = scriptOfLanguage(outputLanguage)
  if (input === "unknown" || output === "unknown" || input === output) return true
  const got = scriptOfText(text)
  return got === "unknown" || got === input
}
