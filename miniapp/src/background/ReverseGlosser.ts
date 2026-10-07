import type {MiniappSession} from "@mentra/miniapp/background"

import {scriptOfLanguage} from "../shared/script"
import type {GlossedWord, LinkLingoSettings} from "../shared/types"
import {inputLanguage, outputLanguage} from "../shared/types"
import {requestGloss} from "./backend"
import {createLogger, diagnostics} from "./observability"
import {rareTokens} from "./prefilter"
import {tunable} from "./tunables"

const log = createLogger("reverse")

// `wordDedupMs` is the forward path's hold-off too, so a repeated fallback
// word does not refill the HUD. `reverseMaxWords` defaults to 2 of the 3 HUD
// slots so the language being learned keeps room.
const LATIN_WORD = /[A-Za-z\u00c0-\u024f][A-Za-z\u00c0-\u024f'’-]*/g
const HAN = /[\u4e00-\u9fff]/

/**
 * Glosses the words a learner falls back to in the language they already
 * read — "我想去那个 museum" — into the language they are learning, so the
 * conversation can carry on in it. Only finals, and only when the two
 * languages have different scripts, because that is the only way to tell
 * which words were the fallback.
 */
export class ReverseGlosser {
  private inFlight = false
  private pending: {text: string; utteranceId?: string} | null = null
  private readonly recent = new Map<string, number>()

  constructor(
    private readonly session: MiniappSession,
    private readonly onWords: (words: GlossedWord[]) => void,
  ) {}

  /** Whether this final carries fallback words worth a call. Queues it when it does. */
  consider(text: string, settings: LinkLingoSettings, utteranceId?: string): boolean {
    if (!reverseApplies(settings)) return false
    const fallback = fallbackWords(text, settings, this.recentKeys(Date.now()))
    if (fallback.length === 0) return false
    if (this.inFlight) {
      // Latest wins: an older fallback is less useful than the one just spoken.
      this.pending = {text, utteranceId}
      diagnostics.increment("reverse.coalesced")
      return true
    }
    void this.run(text, settings, utteranceId)
    return true
  }

  reset(): void {
    this.pending = null
    this.recent.clear()
  }

  private async run(text: string, settings: LinkLingoSettings, utteranceId?: string): Promise<void> {
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
    if (next) void this.run(next.text, settings, next.utteranceId)
  }

  private recentKeys(now: number): string[] {
    for (const [word, at] of this.recent) {
      if (now - at > tunable("wordDedupMs")) this.recent.delete(word)
    }
    return [...this.recent.keys()]
  }
}

/** On only for pairs whose scripts differ, where the fallback words can be told apart. */
export function reverseApplies(settings: LinkLingoSettings): boolean {
  if (!settings.reverseGloss || settings.mode === "translation") return false
  const input = scriptOfLanguage(inputLanguage(settings))
  const output = scriptOfLanguage(outputLanguage(settings))
  return input !== "unknown" && output !== "unknown" && input !== output
}

/**
 * Output-language words in this utterance that are rarer than the cut. Latin
 * runs are pulled out explicitly because Chinese ASR often glues them to the
 * surrounding hanzi with no space ("那个museum看看").
 */
export function fallbackWords(text: string, settings: LinkLingoSettings, recent: Iterable<string> = []): string[] {
  const output = outputLanguage(settings)
  const input = inputLanguage(settings)
  const words =
    scriptOfLanguage(output) === "latin"
      ? (text.match(LATIN_WORD) ?? []).join(" ")
      : [...text].filter((c) => HAN.test(c)).join("")
  if (!words) return []
  const rare = rareTokens(words, output, settings.reverseKnownRank, input, recent)
  // An output language with no bundled list cannot be judged on the phone; let the backend decide.
  if (rare === null) return words.split(/\s+/).filter(Boolean)
  return rare
}

function bare(word: string): string {
  return word.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()
}
