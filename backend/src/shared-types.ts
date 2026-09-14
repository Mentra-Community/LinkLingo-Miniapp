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

/** What the phone knows at the moment the user says "that was wrong". */
export interface FeedbackRequest {
  note: string
  settings: {inputLanguage: string; outputLanguage: string; proficiency: number; mode: string}
  recentUtterances: Array<{text: string; at: number; language?: string}>
  shownWords: Array<{word: string; translation: string; isUpgrade?: boolean; at: number}>
  recentWords: Array<{word: string; translation: string; isUpgrade?: boolean; at: number}>
  caption: string
  translation: string
  original: string
}

export type FeedbackCause =
  | "asr"
  | "language_guard"
  | "candidate_filter"
  | "prompt"
  | "model"
  | "display"
  | "no_problem"
  | "unknown"

export interface FeedbackAnalysis {
  id: string
  model: string
  diagnosis: string
  likelyCause: FeedbackCause
  evidence: string[]
  suggestedFix: string
  suggestedPromptChange?: string
  totalMs: number
}

export interface TranscriptRequest {
  text: string
  detectedLanguage?: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  mode: string
  disposition: TranscriptDisposition
}
