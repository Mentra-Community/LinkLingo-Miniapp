import type {MiniappSession} from "@mentra/miniapp/background"

import {scriptOfLanguage} from "../shared/script"
import type {GlossedWord, LinkLingoSettings} from "../shared/types"
import {inputLanguage, outputLanguage} from "../shared/types"
import {requestGloss} from "./backend"
import {createLogger, diagnostics} from "./observability"
import {listedEnglishWord, rareTokens} from "./prefilter"
import {tunable} from "./tunables"

const log = createLogger("reverse")

// `wordDedupMs` is the forward path's hold-off too, so a repeated fallback
// word does not refill the HUD. `reverseMaxWords` defaults to 2 of the 3 HUD
// slots so the language being learned keeps room.
const LATIN_SPAN =
  /[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'’-]*(?:\s+[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'’-]*)*/g
const HAN = /[\u4e00-\u9fff]/
const FAMILIAR_ACRONYMS = new Set([
  "ai",
  "api",
  "aws",
  "ceo",
  "cpu",
  "gcp",
  "gpu",
  "hr",
  "id",
  "ios",
  "llm",
  "nlp",
  "ok",
  "pdf",
  "sql",
  "ui",
  "uk",
  "url",
  "us",
  "ux",
])

export type FallbackRejectionReason = "stopword" | "short" | "acronym" | "name" | "recent"

export interface FallbackRejection {
  text: string
  reason: FallbackRejectionReason
}

const FALLBACK_STOP_WORDS = new Set([
  "the",
  "and",
  "but",
  "for",
  "from",
  "with",
  "that",
  "this",
  "these",
  "those",
  "you",
  "your",
  "they",
  "their",
  "our",
  "are",
  "was",
  "were",
  "have",
  "has",
  "not",
  "yes",
  "yeah",
  "okay",
])

/**
 * Glosses the words a learner falls back to in the language they already
 * read — "我想去那个 museum" — into the language they are learning, so the
 * conversation can carry on in it. Only finals, and only when the two
 * languages have different scripts, because that is the only way to tell
 * which words were the fallback.
 */
export class ReverseGlosser {
  private inFlight = false
  private pending: {text: string; focusWords: string[]; utteranceId?: string} | null = null
  private readonly recent = new Map<string, number>()

  constructor(
    private readonly session: MiniappSession,
    private readonly onWords: (words: GlossedWord[]) => void,
  ) {}

  /** Whether this final carries fallback words worth a call. Queues it when it does. */
  consider(text: string, settings: LinkLingoSettings, utteranceId?: string): boolean {
    if (!reverseApplies(settings)) return false
    const decision = classifyFallbacks(text, settings, this.recentKeys(Date.now()))
    for (const rejection of decision.rejected) diagnostics.increment(`reverse.reject_${rejection.reason}`)
    const fallback = decision.accepted
    if (fallback.length === 0) return false
    if (this.inFlight) {
      // Latest wins: an older fallback is less useful than the one just spoken.
      this.pending = {text, focusWords: fallback, utteranceId}
      diagnostics.increment("reverse.coalesced")
      return true
    }
    void this.run(text, fallback, settings, utteranceId)
    return true
  }

  reset(): void {
    this.pending = null
    this.recent.clear()
  }

  private async run(
    text: string,
    focusWords: string[],
    settings: LinkLingoSettings,
    utteranceId?: string,
  ): Promise<void> {
    this.inFlight = true
    diagnostics.increment("reverse.requests")
    const eligibleAt = Date.now()
    const result = await requestGloss(
      this.session,
      {
        conversationContext: text,
        // Swapped on purpose: the fallback is written in the output language.
        inputLanguage: outputLanguage(settings),
        outputLanguage: inputLanguage(settings),
        fluencyLevel: settings.proficiency,
        recentWords: this.recentKeys(eligibleAt),
        purpose: "reverse",
        focusWords,
        knownRank: settings.reverseKnownRank,
        maxWords: tunable("reverseMaxWords"),
      },
      {eligibleAt, queueReason: "none", trigger: "final", utteranceId},
    )
    this.inFlight = false

    if (result.ok) {
      const now = Date.now()
      const shown: GlossedWord[] = []
      for (const word of result.data.words) {
        const key = bare(word.word)
        const last = this.recent.get(key)
        if (last && now - last < tunable("wordDedupMs")) continue
        this.recent.set(key, now)
        shown.push({...word, at: now, direction: "reverse"})
      }
      diagnostics.increment("reverse.words", shown.length)
      log.info("reverse gloss applied", {returned: result.data.words.length, shown: shown.length})
      if (shown.length > 0) this.onWords(shown)
    } else {
      diagnostics.increment("reverse.errors")
      log.warn("reverse gloss failed", {message: result.message})
    }

    const next = this.pending
    this.pending = null
    if (next) void this.run(next.text, next.focusWords, settings, next.utteranceId)
  }

  private recentKeys(now: number): string[] {
    for (const [word, at] of this.recent) {
      if (now - at > tunable("wordDedupMs")) this.recent.delete(word)
    }
    return [...this.recent.keys()]
  }
}

/**
 * Chinese gloss mode always translates embedded English. A stored toggle cannot
 * turn that off. Other script pairs still follow the setting.
 */
export function reverseApplies(settings: LinkLingoSettings): boolean {
  if (settings.mode === "translation") return false
  const input = scriptOfLanguage(inputLanguage(settings))
  const output = scriptOfLanguage(outputLanguage(settings))
  if (input === "unknown" || output === "unknown" || input === output) return false
  if (input === "han" && output === "latin") return true
  return settings.reverseGloss
}

/**
 * Output-language words in this utterance that are rarer than the cut. Latin
 * runs are pulled out explicitly because Chinese ASR often glues them to the
 * surrounding hanzi with no space ("那个museum看看").
 */
export function fallbackWords(text: string, settings: LinkLingoSettings, recent: Iterable<string> = []): string[] {
  return classifyFallbacks(text, settings, recent).accepted
}

/** English spans inside Chinese, plus the reason every other span was left out. */
export function classifyFallbacks(
  text: string,
  settings: LinkLingoSettings,
  recent: Iterable<string> = [],
): {accepted: string[]; rejected: FallbackRejection[]} {
  const output = outputLanguage(settings)
  const input = inputLanguage(settings)
  const spans = text.match(LATIN_SPAN) ?? []
  const words = scriptOfLanguage(output) === "latin" ? spans.join(" ") : [...text].filter((c) => HAN.test(c)).join("")
  if (!words) return {accepted: [], rejected: []}
  if (!(scriptOfLanguage(output) === "latin" && HAN.test(text))) {
    const rare = rareTokens(words, output, settings.reverseKnownRank, input, recent)
    if (rare === null) return {accepted: words.split(/\s+/).filter(Boolean), rejected: []}
    return {accepted: rare, rejected: []}
  }

  const seenRecently = new Set([...recent].map((word) => word.toLowerCase()))
  const accepted: string[] = []
  const rejected: FallbackRejection[] = []
  const seen = new Set<string>()
  for (const span of spans) {
    const cleaned = contentSpan(span)
    const key = cleaned.toLowerCase()
    if (!cleaned) {
      rejected.push({text: span, reason: "stopword"})
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    const reason = rejectionReason(cleaned, seenRecently)
    if (reason) rejected.push({text: cleaned, reason})
    else accepted.push(cleaned)
  }
  return {accepted, rejected}
}

function contentSpan(span: string): string {
  const words = span.split(/\s+/).filter((word) => !FALLBACK_STOP_WORDS.has(word.toLowerCase()))
  return words.join(" ").trim()
}

function rejectionReason(span: string, recent: Set<string>): FallbackRejectionReason | null {
  if (recent.has(span.toLowerCase())) return "recent"
  if (isAcronym(span)) return "acronym"
  if (isObviousName(span)) return "name"
  if (!span.includes(" ") && span.length < 3) return "short"
  return null
}

function isAcronym(span: string): boolean {
  return span.split(/\s+/).every((word) => {
    if (FAMILIAR_ACRONYMS.has(word.toLowerCase()) && word === word.toUpperCase()) return true
    return /^[A-Z0-9]{2,6}$/.test(word)
  })
}

/**
 * A single capitalized token with no dictionary morphology is treated as a
 * name. Capitalization alone is not enough: Pretraining and Reinforcement
 * Learning stay because of their shape, not their letters' case.
 */
function isObviousName(span: string): boolean {
  if (span.includes(" ")) return false
  if (listedEnglishWord(span)) return false
  if (/^(pre|re|un|non|multi|cross|anti|inter|over|under)/i.test(span)) return false
  if (/(ing|tion|sion|ment|ity|ism|ize|ise|ous|able|ible|ence|ance)$/i.test(span)) return false
  return /^[A-Z][a-z]{1,14}$/.test(span)
}

function bare(word: string): string {
  return word
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .trim()
}
