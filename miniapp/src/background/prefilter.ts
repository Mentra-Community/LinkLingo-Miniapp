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

/**
 * Ranked terms the phone can require the backend to translate.
 *
 * Sending the exact phone-side matches prevents the backend's different
 * tokenizer from turning a real rare term into `no_candidates`. A lone Han
 * character is withheld unless it repeats: inside an unknown compound it is
 * usually a tokenizer fragment (`预训练` used to become `预 -> pre`), while a
 * repeated single-character word such as `怼` is strong lexical evidence.
 * Unknown compounds still reach the backend through `hasRareToken`, where
 * Jieba can recover their full boundary.
 */
/**
 * Terms worth a forward round trip.
 *
 * Returns null when this phone cannot judge the language. An empty list means
 * the backend's candidate filter would also return nothing, so the caller
 * must not spend the round trip. Consecutive unknown hanzi are stitched into
 * one compound; a lone unknown character is not a candidate unless it repeats.
 */
export function forwardCandidates(
  text: string,
  inputLanguage: string,
  knownRank: number,
  outputLanguage: string,
  recent: Iterable<string> = [],
  maxWords = 3,
): string[] | null {
  const trimmed = (text || "").trim()
  if (!trimmed) return []
  const lang = normalizeLang(inputLanguage)
  if (!lang) return null
  const known = rankMap(lang)
  if (!known) return null
  const seenRecently = new Set<string>()
  for (const word of recent) seenRecently.add(word.toLowerCase())
  const budget = Math.max(1, Math.min(3, Math.floor(maxWords)))
  if (lang !== "zh_cn") {
    const rare = rareTokens(trimmed, inputLanguage, knownRank, outputLanguage, recent)
    return rare === null ? null : rare.slice(0, budget)
  }
  return chineseCandidates(trimmed, known, knownRank, seenRecently).slice(0, budget)
}

export function forwardFocusWords(
  text: string,
  inputLanguage: string,
  knownRank: number,
  outputLanguage: string,
  recent: Iterable<string> = [],
  maxWords = 3,
): string[] {
  return forwardCandidates(text, inputLanguage, knownRank, outputLanguage, recent, maxWords) ?? []
}

function chineseCandidates(text: string, known: Map<string, number>, knownRank: number, recent: Set<string>): string[] {
  const tokens: Array<{token: string; rare: boolean}> = []
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
      if ([...candidate].every((item) => CJK.test(item)) && known.has(candidate)) {
        matched = candidate
        break
      }
    }
    const token = matched || char
    const rank = known.get(token)
    tokens.push({token, rare: rank == null || rank > knownRank})
    i += token.length
  }

  const out: string[] = []
  let unknownRun = ""
  const flush = () => {
    if (unknownRun.length >= 2) out.push(unknownRun.slice(0, MAX_CJK_WORD))
    unknownRun = ""
  }
  const singleCounts = new Map<string, number>()
  for (const token of tokens) {
    if (token.rare && token.token.length === 1) {
      singleCounts.set(token.token, (singleCounts.get(token.token) ?? 0) + 1)
      unknownRun += token.token
      if (unknownRun.length >= MAX_CJK_WORD) flush()
      continue
    }
    flush()
    if (token.rare && !recent.has(token.token.toLowerCase())) out.push(token.token)
  }
  flush()
  for (const [token, count] of singleCounts) {
    if (count > 1 && !recent.has(token.toLowerCase())) out.push(token)
  }
  const seen = new Set<string>()
  return out.filter((token) => {
    const key = token.toLowerCase()
    if (recent.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** True when the English frequency list contains this word, in any casing. */
export function listedEnglishWord(word: string): boolean {
  const known = rankMap("en")
  return Boolean(known?.has(word.toLowerCase()))
}

function isOutputScript(token: string, inputScript: string): boolean {
  if (inputScript === "han") return !CJK.test(token)
  return CJK.test(token)
}
