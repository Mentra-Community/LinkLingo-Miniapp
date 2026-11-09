import type {VocabularyCandidate} from "./vocabulary-contract"

export interface LearnedVocabularyMatch {
  word: string
  translation: string
  rank: number
  appearances: number
  confidence: "high" | "medium" | "low"
}

const UNKNOWN_RANK = 60_001
const CONFIDENCE_SCORE = {low: 0, medium: 1, high: 2} as const
const MAX_USERS = 500
const MAX_TERMS_PER_USER = 1_000

/**
 * In-memory projection of the durable nightly vocabulary batches.
 *
 * The nightly scan finds modern terms, slang and compounds that frequency
 * dictionaries cannot rank. Hydrating those terms into the live path makes
 * yesterday's confirmed hard vocabulary mandatory today and avoids another
 * model call for a translation the scanner already generated.
 */
export class LearnerVocabulary {
  private readonly users = new Map<string, Map<string, LearnedVocabularyMatch>>()

  remember(user: string, candidates: VocabularyCandidate[]): void {
    const terms = this.users.get(user) ?? new Map<string, LearnedVocabularyMatch>()
    this.users.delete(user)
    for (const candidate of candidates) {
      if (candidate.confidence === "low") continue
      const word = candidate.word.trim()
      const translation = candidate.english.trim()
      if (!word || !translation) continue
      const key = word.toLocaleLowerCase()
      const next: LearnedVocabularyMatch = {
        word,
        translation,
        rank: candidate.corpusRank ?? UNKNOWN_RANK,
        appearances: candidate.totalAppearances,
        confidence: candidate.confidence,
      }
      const prior = terms.get(key)
      if (!prior || next.appearances >= prior.appearances) terms.set(key, next)
    }
    while (terms.size > MAX_TERMS_PER_USER) terms.delete(terms.keys().next().value!)
    this.users.set(user, terms)
    while (this.users.size > MAX_USERS) this.users.delete(this.users.keys().next().value!)
  }

  match(
    user: string | undefined,
    context: string,
    knownRank: number,
    recent: Iterable<string>,
    maxWords: number,
  ): LearnedVocabularyMatch[] {
    if (!user) return []
    const terms = this.users.get(user)
    if (!terms) return []
    const recentSet = new Set([...recent].map((word) => bare(word)))
    return [...terms.values()]
      .filter((term) => term.rank > knownRank && !recentSet.has(bare(term.word)) && context.includes(term.word))
      .sort(
        (a, b) =>
          b.appearances - a.appearances ||
          CONFIDENCE_SCORE[b.confidence] - CONFIDENCE_SCORE[a.confidence] ||
          b.word.length - a.word.length ||
          b.rank - a.rank,
      )
      .slice(0, Math.max(1, Math.min(3, maxWords)))
  }

  clear(): void {
    this.users.clear()
  }
}

function bare(word: string): string {
  return word
    .toLocaleLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .trim()
}

export const learnerVocabulary = new LearnerVocabulary()
