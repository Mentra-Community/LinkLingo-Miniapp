/**
 * Writing-system detection for the language guard.
 *
 * A learner hearing Chinese and reading English does not need English words
 * glossed — they already read English. When the speaker switches to English
 * entirely, every token in the transcript is in the learner's own language, and
 * glossing it produces English→English rows. Script is a cheap, reliable proxy
 * for "which of the two configured languages is this token in" whenever the
 * two languages use different writing systems; for same-script pairs (English
 * → Spanish) it says nothing and the guard stays out of the way.
 */

export type Script = "han" | "latin" | "cyrillic" | "arabic" | "hangul" | "unknown"

const LANGUAGE_SCRIPTS: Record<string, Script> = {
  zh: "han",
  chinese: "han",
  en: "latin",
  english: "latin",
  es: "latin",
  spanish: "latin",
  fr: "latin",
  french: "latin",
  de: "latin",
  german: "latin",
  it: "latin",
  italian: "latin",
  pt: "latin",
  portuguese: "latin",
  nl: "latin",
  dutch: "latin",
  tr: "latin",
  turkish: "latin",
  ru: "cyrillic",
  russian: "cyrillic",
  ar: "arabic",
  arabic: "arabic",
  ko: "hangul",
  korean: "hangul",
}

/**
 * Per-character weight, so scripts are compared by roughly how much speech
 * each character carries. One hanzi or hangul block is a syllable; an
 * alphabetic letter is about a third of one. Without this `我们去 museum`
 * counted as English (3 vs 6) and a Chinese sentence with one loanword was
 * skipped as the speaker's own language.
 */
const COUNTERS: Array<[Script, RegExp, number]> = [
  ["han", /[\u4e00-\u9fff]/g, 3],
  ["hangul", /[\uac00-\ud7af\u1100-\u11ff]/g, 3],
  ["cyrillic", /[\u0400-\u04ff]/g, 1],
  ["arabic", /[\u0600-\u06ff]/g, 1],
  ["latin", /[A-Za-z\u00c0-\u024f]/g, 1],
]

/** Parenthesised text is annotation (pinyin, a gloss), not the word itself. */
const ANNOTATION = /\([^)]*\)/g

/** Script a language is written in; accepts codes, names and "Chinese (Pinyin)". */
export function scriptOfLanguage(language: string): Script {
  const key = language.toLowerCase().replace(/\(.*?\)/g, "").trim()
  const bare = key.split(/[-_]/)[0] ?? key
  return LANGUAGE_SCRIPTS[key] ?? LANGUAGE_SCRIPTS[bare] ?? "unknown"
}

/**
 * Dominant script of a text by weighted character count, ignoring anything in
 * parentheses, so `museum (博物馆)` reads as latin and `博物馆 (bó wù guǎn)` as
 * han. Digits and punctuation carry no script and yield "unknown".
 */
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

/** True when the two configured languages can be told apart by script alone. */
export function scriptsDiffer(inputLanguage: string, outputLanguage: string): boolean {
  const input = scriptOfLanguage(inputLanguage)
  const output = scriptOfLanguage(outputLanguage)
  return input !== "unknown" && output !== "unknown" && input !== output
}

/**
 * Whether a transcript token is written in the input (learning) language. Only
 * decides when the two languages differ in script; otherwise every token passes.
 */
export function tokenInInputLanguage(token: string, inputLanguage: string, outputLanguage: string): boolean {
  if (!scriptsDiffer(inputLanguage, outputLanguage)) return true
  const got = scriptOfText(token)
  return got === "unknown" || got === scriptOfLanguage(inputLanguage)
}

/**
 * A translation that is still written in the input language's script is not a
 * translation — the model echoed a synonym or left the word alone. Only
 * decidable when the two languages differ in script.
 */
export function looksUntranslated(translation: string, inputLanguage: string, outputLanguage: string): boolean {
  if (!scriptsDiffer(inputLanguage, outputLanguage)) return false
  const got = scriptOfText(translation)
  return got !== "unknown" && got !== scriptOfLanguage(outputLanguage)
}
