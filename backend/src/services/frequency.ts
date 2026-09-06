import {Jieba} from "@node-rs/jieba"
import {dict} from "@node-rs/jieba/dict"
import {readFileSync} from "fs"
import {join} from "path"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"

const log = createLogger("frequency")

const jieba = Jieba.withDict(dict)

const LANG_ALIASES: Record<string, string> = {
  english: "en",
  en: "en",
  "en-us": "en",
  spanish: "es",
  es: "es",
  russian: "ru",
  ru: "ru",
  french: "fr",
  fr: "fr",
  chinese: "zh_cn",
  zh: "zh_cn",
  "zh-cn": "zh_cn",
  "zh_cn": "zh_cn",
  "chinese (hanzi)": "zh_cn",
  "chinese (pinyin)": "zh_cn",
  german: "de",
  de: "de",
  arabic: "ar",
  ar: "ar",
  korean: "ko",
  ko: "ko",
  italian: "it",
  it: "it",
  turkish: "tr",
  tr: "tr",
  portuguese: "pt",
  pt: "pt",
  dutch: "nl",
  nl: "nl",
}

/** Vocabulary size assumed for proficiency 0 and 100 respectively (roughly A1 to C2). */
const MIN_KNOWN_RANK = 300
const MAX_KNOWN_RANK = 15000

const MIN_LATIN_LEN = 4
const CANDIDATE_LIMIT = 12
/** Only used to rank dictionary misses when the dictionary itself failed to load. */
const DEFAULT_DICT_SIZE = 50000
/** Dictionary misses are mostly names and mistranscriptions, so only a couple get through. */
const UNKNOWN_CANDIDATE_LIMIT = 2
/**
 * A single hanzi is only treated as a decomposable piece of a compound when it
 * is common on its own. `馆` (rank 13593) is rare standalone, so `博物馆` stays
 * a real vocabulary item, while `冷` (rank 1245) lets `太冷` collapse to `冷`.
 */
const SINGLE_CHAR_PART_MAX_RANK = 1500
/**
 * A lone hanzi only counts as vocabulary when it is genuinely rare. Rank cannot
 * separate content from grammar below about 3600 — 猫 (1292) sits among 少
 * (1170) and 冷 (1245) — but above 4000 the band is clean content: 碗 (5593),
 * 盐 (5895), 伞 (9939), against a rarest modifier of 蛮 (3597). Below the bar a
 * single character is nearly always a modifier or particle that means little
 * glossed on its own.
 */
const SINGLE_CHAR_MIN_CANDIDATE_RANK = 4000

const CJK = /[\u4e00-\u9fff]/
const CJK_ONLY = /^[\u4e00-\u9fff]+$/
/** A count, optionally with its measure word: 三, 三十, 三个, 几件. */
const CJK_NUMERAL = /^[零〇一二三四五六七八九十百千万亿兆两几半]+[个只件张台本条位次遍种双份块年月日天岁]?$/
const CJK_ORDINAL = /^第[零〇一二三四五六七八九十百千万]/
const CJK_PERCENT = /^百分之/
const DIGITS_ONLY = /^[\d\s.,:%\-+/]+$/

/**
 * Function words that should never be sent to the model. Rank alone does not
 * catch all of them: `就是` and `什么` are frequent enough to fall inside any
 * learner's known vocabulary, but a mis-ranked dictionary must not leak them.
 */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "it",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "and",
  "or",
  "in",
  "on",
  "at",
  "for",
  "with",
  "this",
  "that",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "的",
  "了",
  "是",
  "在",
  "我",
  "你",
  "他",
  "她",
  "它",
  "这",
  "那",
  "有",
  "和",
  "就",
  "都",
  "也",
  "很",
  "到",
  "说",
  "要",
  "会",
  "能",
  "把",
  "被",
  "从",
  "对",
  "与",
  "或",
  "但",
  "及",
  "啊",
  "吗",
  "呢",
  "吧",
  "哇",
  "我们",
  "他们",
  "她们",
  "什么",
  "怎么",
  "一个",
  "这个",
  "那个",
  "因为",
  "所以",
  "但是",
  "如果",
  "可以",
  "没有",
  "不是",
  "就是",
])

export interface WordCandidate {
  word: string
  /** Frequency rank in the source dictionary; 1 is the most common word. */
  rank: number
  /** How far past the learner's estimated vocabulary the word sits. */
  gap: number
  /** The word is absent from the dictionary, so its rank is a lower bound only. */
  unknown: boolean
}

interface LangDict {
  ranks: Map<string, number>
  total: number
  /** Tokens dropped as contamination when the dictionary was loaded. */
  dropped: number
}

const cache = new Map<string, LangDict>()

/**
 * A dictionary that fails to load is not fatal — every token just scores as
 * unknown and the model gets fed noise. Recording the failure is the only way
 * to tell that apart from a genuinely rare vocabulary.
 */
const failedDicts = new Map<string, string>()

export function dictionaryDiagnostics(): {
  loaded: Record<string, number>
  failed: Record<string, string>
} {
  const loaded: Record<string, number> = {}
  for (const [lang, entry] of cache) loaded[lang] = entry.total
  return {loaded, failed: Object.fromEntries(failedDicts)}
}

/**
 * Estimated size of the learner's active vocabulary, log-linear across the
 * slider so every step moves the cut-off instead of four coarse bands.
 * 0 -> 300, 25 -> ~800, 50 -> ~2100, 75 -> ~5600, 100 -> 15000.
 */
export function knownRankFor(proficiency: number): number {
  const raw = Number.isFinite(proficiency) ? proficiency : 50
  const p = Math.min(100, Math.max(0, raw)) / 100
  return Math.round(MIN_KNOWN_RANK * Math.pow(MAX_KNOWN_RANK / MIN_KNOWN_RANK, p))
}

function normalizeLang(code: string): string {
  const key = code.toLowerCase().replace(/\(.*?\)/g, "").trim()
  const bare = key.split("-")[0] ?? key
  return LANG_ALIASES[key] ?? LANG_ALIASES[bare] ?? (bare === "zh" ? "zh_cn" : bare)
}

/**
 * The OpenSubtitles-derived Chinese list carries ~7k Latin tokens (`the`, `pos`,
 * `chffffff`), 246 of them inside the top 2000. Left in place they push every
 * real word several hundred ranks rarer, which lands squarely in the beginner
 * band, so they are removed before ranks are assigned.
 */
function isContamination(lang: string, word: string): boolean {
  if (lang !== "zh_cn") return false
  return !CJK.test(word)
}

function loadDict(lang: string): LangDict | null {
  if (cache.has(lang)) return cache.get(lang)!
  if (failedDicts.has(lang)) return null
  const path = join(import.meta.dir, "../../data/freq", `${lang}.json`)
  const started = Date.now()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as string[]
    const words = raw.filter((word) => !isContamination(lang, word))
    const ranks = new Map<string, number>()
    words.forEach((word, i) => ranks.set(word, i + 1))
    const loaded = {ranks, total: words.length || 1, dropped: raw.length - words.length}
    cache.set(lang, loaded)
    metrics.increment("dictionary_loads_total", {lang, outcome: "ok"})
    log.info("frequency dictionary loaded", {
      lang,
      words: words.length,
      droppedTokens: loaded.dropped,
      loadMs: Date.now() - started,
    })
    return loaded
  } catch (error) {
    const reason = (error as Error).message
    failedDicts.set(lang, reason)
    metrics.increment("dictionary_loads_total", {lang, outcome: "failed"})
    log.error("frequency dictionary unavailable; all tokens will score as unknown", {
      lang,
      path,
      error: reason,
    })
    return null
  }
}

function tokenize(text: string, lang: string): string[] {
  if (lang === "zh_cn" || CJK.test(text)) {
    return jieba.cut(text).map((w) => w.trim()).filter(Boolean)
  }
  return text.split(/\s+/).map((w) => w.trim()).filter(Boolean)
}

function dictForToken(token: string, lang: string): LangDict | null {
  let dictLang = lang
  if (CJK.test(token)) dictLang = "zh_cn"
  else if (/^[a-zA-Z]+$/.test(token) && lang !== "en") dictLang = "en"
  return loadDict(dictLang) ?? loadDict(lang)
}

/**
 * Rank of the most common lemma an inflected form reduces to. Inflections are
 * either missing from the frequency list (`walked` scored as an unknown word
 * and was glossed to a beginner) or listed far rarer than their stem
 * (`examines` sits at 39874 while `examine` is an ordinary word). Either way a
 * learner who knows the stem can read the inflection.
 */
function lemmaRank(word: string, dict: LangDict): number | null {
  const lower = word.toLowerCase()
  const variants = [
    lower.replace(/ies$/, "y"),
    lower.replace(/es$/, ""),
    lower.replace(/es$/, "e"),
    lower.replace(/s$/, ""),
    lower.replace(/ed$/, ""),
    lower.replace(/ed$/, "e"),
    lower.replace(/ing$/, ""),
    lower.replace(/ing$/, "e"),
    lower.replace(/ly$/, ""),
    lower.replace(/ally$/, "al"),
    lower.replace(/(.)\1(?:ed|ing)$/, "$1"),
  ]
  let best: number | null = null
  for (const variant of variants) {
    if (variant === lower || variant.length < 3) continue
    const rank = dict.ranks.get(variant)
    if (rank != null && (best == null || rank < best)) best = rank
  }
  return best
}

/**
 * Splits a hanzi compound into dictionary words and reports the rarest piece.
 * `今天下午` ranks 4174 as a unit but decomposes into `今天`+`下午` (1135), and a
 * learner who knows both parts does not need it glossed. Returns null when the
 * token cannot be built out of anything but itself.
 */
function compositionalRank(token: string, dict: LangDict): number | null {
  const n = token.length
  if (n < 2) return null
  // best[i] is the rarest-piece rank of the cheapest split of token[0..i).
  const best: (number | null)[] = new Array(n + 1).fill(null)
  best[0] = 0
  for (let i = 0; i < n; i++) {
    const prefix = best[i]
    if (prefix == null) continue
    for (let j = i + 1; j <= n; j++) {
      if (i === 0 && j === n) continue
      const part = token.slice(i, j)
      const rank = dict.ranks.get(part)
      if (rank == null) continue
      if (part.length === 1 && rank > SINGLE_CHAR_PART_MAX_RANK) continue
      const worst = Math.max(prefix, rank)
      const current = best[j]
      if (current == null || worst < current) best[j] = worst
    }
  }
  return best[n]
}

/** True for tokens that carry no vocabulary value however rare they look. */
function isNoise(token: string): boolean {
  if (DIGITS_ONLY.test(token)) return true
  if (!CJK.test(token)) return false
  return CJK_NUMERAL.test(token) || CJK_ORDINAL.test(token) || CJK_PERCENT.test(token)
}

interface ScoredToken {
  word: string
  rank: number | null
  /** Rank assigned when the dictionary has no entry: one past its rarest word. */
  unknownRank: number
}

/**
 * The rank we treat a token as having: its own, or the rarest piece of its
 * decomposition when that is more common. Null means the dictionary has no
 * opinion at all.
 */
function effectiveRank(token: string, dict: LangDict): number | null {
  const isCjk = CJK.test(token)
  const key = isCjk ? token : token.toLowerCase()
  const direct = dict.ranks.get(key) ?? null
  const reduced = isCjk ? compositionalRank(token, dict) : lemmaRank(key, dict)
  if (reduced != null && (direct == null || reduced < direct)) return reduced
  return direct
}

export function lookupRank(word: string, language: string): number | null {
  const cleaned = word.split("'")[0].replace(/[?。!.,;？"，！、]/g, "").trim()
  if (!cleaned) return null
  const dict = dictForToken(cleaned, normalizeLang(language))
  if (!dict) return null
  return effectiveRank(cleaned, dict)
}

function scoreTokens(transcript: string, language: string): ScoredToken[] {
  const lang = normalizeLang(language)
  const seen = new Map<string, ScoredToken>()
  for (const raw of tokenize(transcript, lang)) {
    const isCjk = CJK.test(raw)
    const cleaned = raw.replace(/[?。!.,;？"，！、]/g, "").trim()
    if (!cleaned) continue
    if (/^[^\w\u4e00-\u9fff]+$/.test(cleaned)) continue
    if (!isCjk && cleaned.length < MIN_LATIN_LEN) continue
    if (isNoise(cleaned)) continue
    if (STOP_WORDS.has(cleaned) || STOP_WORDS.has(cleaned.toLowerCase())) continue
    const dict = dictForToken(cleaned, lang)
    const rank = dict ? effectiveRank(cleaned, dict) : null
    if (rank == null) {
      // A hanzi token this short that no dictionary knows is jieba splitting
      // mid-phrase (`少吃`), not vocabulary. Latin capitals are proper nouns.
      if (isCjk && cleaned.length <= 2) continue
      if (!isCjk && /^[A-Z]/.test(cleaned)) continue
    } else if (isCjk && cleaned.length === 1 && rank < SINGLE_CHAR_MIN_CANDIDATE_RANK) {
      continue
    }
    const key = isCjk ? cleaned : cleaned.toLowerCase()
    const prior = seen.get(key)
    if (prior && (prior.rank == null || (rank != null && rank <= prior.rank))) continue
    seen.set(key, {word: key, rank, unknownRank: (dict?.total ?? DEFAULT_DICT_SIZE) + 1})
  }
  return [...seen.values()]
}

/**
 * Words the learner plausibly does not know: everything ranked rarer than their
 * estimated vocabulary, rarest first. Returns nothing when the speech is fully
 * inside their vocabulary — for a fluent learner that is the correct answer, and
 * the HUD idle line already covers it.
 */
export function candidateWords(
  transcript: string,
  language: string,
  recent: string[] = [],
  knownRank = knownRankFor(50),
): WordCandidate[] {
  const recentSet = new Set(recent.map((w) => w.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()))
  const known: WordCandidate[] = []
  const unknown: WordCandidate[] = []

  for (const token of scoreTokens(transcript, language)) {
    if (recentSet.has(token.word.toLowerCase())) continue
    if (token.rank == null) {
      unknown.push({
        word: token.word,
        rank: token.unknownRank,
        gap: token.unknownRank - knownRank,
        unknown: true,
      })
      continue
    }
    if (token.rank <= knownRank) continue
    known.push({word: token.word, rank: token.rank, gap: token.rank - knownRank, unknown: false})
  }

  known.sort((a, b) => b.gap - a.gap)
  unknown.sort((a, b) => b.word.length - a.word.length)
  return [...known, ...unknown.slice(0, UNKNOWN_CANDIDATE_LIMIT)].slice(0, CANDIDATE_LIMIT)
}

export {
  MAX_KNOWN_RANK,
  MIN_KNOWN_RANK,
  normalizeLang,
  SINGLE_CHAR_MIN_CANDIDATE_RANK,
  SINGLE_CHAR_PART_MAX_RANK,
}
