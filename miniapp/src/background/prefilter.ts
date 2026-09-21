/**
 * On-device "is anything here worth glossing?" check.
 *
 * For a fluent learner most utterances contain nothing above their vocabulary,
 * and every one of those still cost a full round trip to be told so. This
 * decides locally, using the head of the same frequency lists the backend
 * ranks with.
 *
 * Deliberately one-sided. Saying "there is something rare" when the backend
 * would have found nothing only costs the call we were making anyway; saying
 * "nothing here" when the backend would have found a word loses a gloss. So
 * every uncertainty resolves to `true`, including unknown tokens, languages
 * with no bundled list, and anything the tokenizer could not place.
 */

import knownEn from "../generated/known-en.json"
import knownZhCn from "../generated/known-zh_cn.json"
import {scriptOfLanguage} from "../shared/script"

/** Longest entry the CJK matcher will try; covers the four-character idioms. */
const MAX_CJK_WORD = 4
const CJK = /[\u4e00-\u9fff]/
const LATIN_TRIM = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu
const DIGITS_ONLY = /^\p{N}+$/u

/** Only languages whose list is worth the bundle weight; everything else calls out. */
const SOURCES: Record<string, string[]> = {
  zh_cn: knownZhCn as string[],
  en: knownEn as string[],
}

const ranks = new Map<string, Map<string, number>>()

/** Mirrors the backend's normalizeLang for the two languages that ship a list. */
function normalizeLang(language: string): string | null {
  const bare = (language || "").toLowerCase().split(/[-_]/)[0]
  if (bare === "zh" || bare === "chinese") return "zh_cn"
  if (bare === "en" || bare === "english") return "en"
  return null
}

/** Built on first use: 15k Map inserts is not worth paying at startup. */
function rankMap(lang: string): Map<string, number> | null {
  const cached = ranks.get(lang)
  if (cached) return cached
  const words = SOURCES[lang]
  if (!words) return null
  const map = new Map<string, number>()
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    // The lists are rank-ordered, so a repeated form keeps its best rank.
    if (!map.has(word)) map.set(word, i + 1)
  }
  ranks.set(lang, map)
  return map
}

/**
 * Forward maximum matching against the known-word list. Anything that fails to
 * match is left as a single character and treated as unknown, which is the
 * conservative direction: leftovers cause a call rather than suppressing one.
 */
function cjkTokens(text: string, known: Map<string, number>): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const char = text[i]!
    if (!CJK.test(char)) {
      i += 1
      continue
    }
    let matched = ""
    for (let len = Math.min(MAX_CJK_WORD, text.length - i); len >= 2; len--) {
      const candidate = text.slice(i, i + len)
      if (known.has(candidate)) {
        matched = candidate
        break
      }
    }
    out.push(matched || char)
    i += matched.length || 1
  }
  return out
}

function latinTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(LATIN_TRIM, "").toLowerCase())
    .filter(Boolean)
}

/**
 * Tokens above the learner's vocabulary, rarest first. `null` means "cannot
 * tell" — an unsupported language or an untokenizable string — which callers
 * must treat as "call the backend".
 */
export function rareTokens(
  text: string,
  inputLanguage: string,
  knownRank: number,
  outputLanguage: string,
  recent: Iterable<string> = [],
): string[] | null {
  const trimmed = (text || "").trim()
  if (!trimmed) return []
  // The backend drops recently shown words from its candidate list, so a
  // context whose only rare words are already on the HUD really does have
  // nothing left to gloss. Without this the running 30s buffer keeps one old
  // rare word alive and the prefilter never suppresses anything.
  const seenRecently = new Set<string>()
  for (const word of recent) seenRecently.add(word.toLowerCase())

  const lang = normalizeLang(inputLanguage)
  if (!lang) return null
  const known = rankMap(lang)
  if (!known) return null

  const inputScript = scriptOfLanguage(inputLanguage)
  const outputScript = scriptOfLanguage(outputLanguage)
  const tokens = lang === "zh_cn" ? cjkTokens(trimmed, known) : latinTokens(trimmed)
  // No token at all means the tokenizer had nothing to say about this text,
  // not that the text is all known.
  if (tokens.length === 0) return null

  const rare: Array<{token: string; rank: number}> = []
  const seen = new Set<string>()
  for (const token of tokens) {
    if (DIGITS_ONLY.test(token)) continue
    // A token written in the language the learner already reads is not
    // vocabulary; the backend drops these too.
    if (inputScript !== outputScript && isOutputScript(token, inputScript)) continue
    if (seenRecently.has(token.toLowerCase())) continue
    const rank = known.get(token)
    if (rank != null && rank <= knownRank) continue
    if (seen.has(token)) continue
    seen.add(token)
    // Unlisted words are rarer than anything the list can rank.
    rare.push({token, rank: rank ?? Number.MAX_SAFE_INTEGER})
  }
  return rare.sort((a, b) => b.rank - a.rank).map((r) => r.token)
}

/**
 * True when the backend might find something to gloss, so the call is worth
 * making. False only when every token is comfortably inside the learner's
 * vocabulary.
 */
export function hasRareToken(
  text: string,
  inputLanguage: string,
  knownRank: number,
  outputLanguage: string,
  recent: Iterable<string> = [],
): boolean {
  const rare = rareTokens(text, inputLanguage, knownRank, outputLanguage, recent)
  return rare === null || rare.length > 0
}

function isOutputScript(token: string, inputScript: string): boolean {
  if (inputScript === "han") return !CJK.test(token)
  return CJK.test(token)
}
