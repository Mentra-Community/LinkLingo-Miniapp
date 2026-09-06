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

const COMMON_PERCENTILE = 4
const UNKNOWN_PERCENTILE = 98.2
const MIN_LATIN_LEN = 4
const FALLBACK_CANDIDATE_LIMIT = 8

/**
 * Function words that should never be sent to the model, even when we relax
 * the rarity floor so everyday speech still produces *some* candidates.
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
  percentile: number
}

interface LangDict {
  ranks: Map<string, number>
  total: number
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

function normalizeLang(code: string): string {
  const key = code.toLowerCase().replace(/\(.*?\)/g, "").trim()
  const bare = key.split("-")[0] ?? key
  return LANG_ALIASES[key] ?? LANG_ALIASES[bare] ?? (bare === "zh" ? "zh_cn" : bare)
}

function loadDict(lang: string): LangDict | null {
  if (cache.has(lang)) return cache.get(lang)!
  if (failedDicts.has(lang)) return null
  const path = join(import.meta.dir, "../../data/freq", `${lang}.json`)
  const started = Date.now()
  try {
    const words = JSON.parse(readFileSync(path, "utf8")) as string[]
    const ranks = new Map<string, number>()
    words.forEach((word, i) => ranks.set(word, i + 1))
    const loaded = {ranks, total: words.length || 1}
    cache.set(lang, loaded)
    metrics.increment("dictionary_loads_total", {lang, outcome: "ok"})
    log.info("frequency dictionary loaded", {
      lang,
      words: words.length,
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
  if (lang === "zh_cn" || /[\u4e00-\u9fff]/.test(text)) {
    return jieba.cut(text).map((w) => w.trim()).filter(Boolean)
  }
  return text.split(/\s+/).map((w) => w.trim()).filter(Boolean)
}

function lookupPercentile(token: string, lang: string): number {
  const isChinese = /[\u4e00-\u9fff]/.test(token)
  const isEnglish = /^[a-zA-Z]+$/.test(token)
  let dictLang = lang
  if (isChinese && lang !== "zh_cn") dictLang = "zh_cn"
  else if (isEnglish && lang !== "en") dictLang = "en"
  const dict = loadDict(dictLang) ?? loadDict(lang)
  if (!dict) return UNKNOWN_PERCENTILE
  const cleaned = (isChinese ? token : token.toLowerCase())
    .split("'")[0]
    .replace(/[?。!.,;？"]/g, "")
  const rank = dict.ranks.get(cleaned)
  if (rank == null) return UNKNOWN_PERCENTILE
  return Math.round((rank / dict.total) * 1000) / 10
}

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word) || STOP_WORDS.has(word.toLowerCase())
}

export function rankWords(transcript: string, language: string): Record<string, number> {
  const ranks: Record<string, number> = {}
  for (const token of scoreTokens(transcript, language)) {
    if (token.percentile <= COMMON_PERCENTILE) continue
    ranks[token.word] = token.percentile
  }
  return ranks
}

function scoreTokens(transcript: string, language: string): WordCandidate[] {
  const lang = normalizeLang(language)
  const seen = new Map<string, number>()
  for (const raw of tokenize(transcript, lang)) {
    const isChinese = /[\u4e00-\u9fff]/.test(raw)
    const cleaned = raw.replace(/[?。!.,;？"]/g, "").trim()
    if (!cleaned) continue
    if (/^[^\w\u4e00-\u9fff]+$/.test(cleaned)) continue
    if (!isChinese && cleaned.length < MIN_LATIN_LEN) continue
    if (isStopWord(cleaned)) continue
    const percentile = lookupPercentile(cleaned, lang)
    const key = isChinese ? cleaned : cleaned.toLowerCase()
    const prior = seen.get(key)
    if (prior == null || percentile > prior) seen.set(key, percentile)
  }
  return [...seen.entries()].map(([word, percentile]) => ({word, percentile}))
}

export function candidateWords(
  transcript: string,
  language: string,
  recent: string[] = [],
  minPercentile = 0.5,
): WordCandidate[] {
  const recentSet = new Set(recent.map((w) => w.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()))
  const scored = scoreTokens(transcript, language).filter((token) => !recentSet.has(token.word.toLowerCase()))
  const rare = scored
    .filter((token) => token.percentile >= minPercentile && token.percentile > COMMON_PERCENTILE)
    .sort((a, b) => b.percentile - a.percentile)

  if (rare.length > 0) return rare

  // Everyday Chinese is almost entirely below the rarity floor. Returning
  // nothing here used to skip Gemini entirely, which looked like a backend
  // failure: speech comes in, HUD stays blank. Fall back to the least-common
  // content tokens so the model still has something to pick from.
  if (scored.length > 0) metrics.increment("gloss_fallback_candidates_total")
  return scored.sort((a, b) => b.percentile - a.percentile).slice(0, FALLBACK_CANDIDATE_LIMIT)
}

export function fluencyThreshold(fluency: number): number {
  if (fluency < 30) return 0.5
  if (fluency < 50) return 2
  if (fluency < 75) return 5
  return 10
}

export {normalizeLang, COMMON_PERCENTILE}
