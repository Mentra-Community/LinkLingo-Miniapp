export interface GlossRequest {
  conversationContext: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  recentWords?: string[]
}

export interface GlossedWord {
  word: string
  translation: string
}

export interface GlossProfiling {
  totalMs: number
  geminiMs?: number
  parseMs?: number
  model: string
  candidateCount: number
  /** Vocabulary size assumed for this learner; the rank cut-off for candidates. */
  knownRank?: number
}

export interface GlossResponse {
  words: GlossedWord[]
  profiling: GlossProfiling
}

export interface UpgradeRequest {
  conversationContext: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  recentUpgrades?: string[]
}

export interface UpgradeResponse {
  word?: string
  meaning?: string
  profiling: GlossProfiling
}

/**
 * Why this final utterance did or did not go to the model. The transcript
 * tape records every final, including the ones the phone skipped, so a
 * reviewer can see speech the glasses heard but never glossed.
 */
export type TranscriptDisposition =
  | "queued_gloss"
  | "skipped_language"
  | "skipped_short"
  | "skipped_duplicate"
  | "skipped_cooldown"
  | "translation_mode"
  | "heard"

export interface TranscriptRequest {
  text: string
  detectedLanguage?: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  mode: string
  disposition: TranscriptDisposition
}
