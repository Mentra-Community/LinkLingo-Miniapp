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

export function rankWords(transcript: string, language: string): Record<string, number> {
  const lang = normalizeLang(language)
  const ranks: Record<string, number> = {}
  for (const raw of tokenize(transcript, lang)) {
    const isChinese = /[\u4e00-\u9fff]/.test(raw)
    const cleaned = raw.replace(/[?。!.,;？"]/g, "").trim()
    if (!cleaned) continue
    if (/^[^\w\u4e00-\u9fff]+$/.test(cleaned)) continue
    const percentile = lookupPercentile(cleaned, lang)
    if (percentile <= COMMON_PERCENTILE) continue
    if (!isChinese && cleaned.length < MIN_LATIN_LEN) continue
    ranks[cleaned.toLowerCase()] = percentile
  }
  return ranks
}

export function candidateWords(
  transcript: string,
  language: string,
  recent: string[] = [],
  minPercentile = 0.5,
): WordCandidate[] {
  const recentSet = new Set(recent.map((w) => w.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()))
  const ranks = rankWords(transcript, language)
  return Object.entries(ranks)
    .filter(([word, percentile]) => percentile >= minPercentile && !recentSet.has(word))
    .map(([word, percentile]) => ({word, percentile}))
    .sort((a, b) => b.percentile - a.percentile)
}

export function fluencyThreshold(fluency: number): number {
  if (fluency < 30) return 0.5
  if (fluency < 50) return 2
  if (fluency < 75) return 5
  return 10
}

export {normalizeLang, COMMON_PERCENTILE}
