/** What made a gloss eligible. Interim triggering ships in 1.0.17. */
export type GlossTrigger = "final" | "interim"

/** Which mechanism delayed a gloss between becoming eligible and being sent. */
export type GlossQueueReason = "none" | "cooldown" | "in_flight" | "coalesced"

/** Timings for the gloss carrying this payload. */
export interface GlossClientCurrent {
  requestId: string
  requestSeq: number
  utteranceId?: string
  trigger: GlossTrigger
  eligibleAt: number
  queueReason: GlossQueueReason
  queueWaitMs: number
  networkIdleMs?: number
}

/**
 * The phone's completed timings for an *earlier* gloss. A client only learns
 * its round trip after the response has landed, so the numbers arrive one
 * request late; `requestId` is what lets the server attach them to the entry
 * they actually describe instead of to the request that carried them.
 */
export interface GlossClientPrevious {
  requestId: string
  roundTripMs: number
  renderMs?: number
  triggerToRenderMs?: number
  outcome: "ok" | "error"
}

export interface GlossClientTelemetry {
  version: string
  buildId: string
  sessionId: string
  current: GlossClientCurrent
  previousRequestMetrics?: GlossClientPrevious
}

export type GlossPurpose = "forward" | "reverse"

export interface GlossRequest {
  conversationContext: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  recentWords?: string[]
  /**
   * `reverse` glosses the output-language words a learner fell back to (English
   * in a Chinese session) into the language they are learning. It sends
   * input/output swapped plus its own rank cut and pick budget.
   */
  purpose?: GlossPurpose
  /** Overrides the rank cut derived from `fluencyLevel`. Clamped server-side. */
  knownRank?: number
  /** Overrides the pick budget derived from `fluencyLevel`. Clamped to 1–3. */
  maxWords?: number
  /** Per-request client identity and phase timings; absent on pre-1.0.16 phones. */
  client?: GlossClientTelemetry
  /**
   * Pre-1.0.16 shape: the bare round trip of the previous call, with no id to
   * attach it to. Accepted for one release so installed 1.0.15 phones keep
   * contributing a number, then removed.
   * @deprecated Use `client.previousRequestMetrics`.
   */
  clientRoundTripMs?: number
}

export interface GlossedWord {
  word: string
  translation: string
}

export interface GlossProfiling {
  totalMs: number
  /**
   * Pre-1.0.16 name for `llmMs`, still emitted so an installed 1.0.15 phone
   * keeps showing a model time. Drop once no such phone reports in.
   * @deprecated
   */
  geminiMs?: number
  llmMs?: number
  parseMs?: number
  model: string
  candidateCount: number
  /** Vocabulary size assumed for this learner; the rank cut-off for candidates. */
  knownRank?: number
  /** Echo of the client-minted id, so a WebView row can be found on the tape. */
  requestId?: string
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
  /**
   * The phone's own frequency check found nothing above the learner's
   * vocabulary, so no request was made. These replace the `no_words` gloss
   * calls that previously paid a round trip to learn the same thing.
   */
  | "skipped_no_candidates"
  /** Speech in the output language, glossed back into the language being learned. */
  | "reverse_gloss"
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

/** The analyst's plain-text reply to a comment about recent translations. */
export interface FeedbackAnalysis {
  id: string
  model: string
  answer: string
  totalMs: number
  /** Set when the comment asked for a change and a coding agent was started for it. */
  change?: CodeChange
}

export type ReportRange = "day" | "week"

export interface ReportWord {
  word: string
  translation: string
  count: number
  lastAt: number
}

export interface ReportDay {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  words: number
  fallbacks: number
  heard: number
}

/** One day or one week of the learner's ledger, grouped by the phone's local day. */
export interface Report {
  range: ReportRange
  /** Local date the period ends on. */
  date: string
  tzOffsetMin: number
  from: number
  to: number
  totals: {wordsShown: number; uniqueWords: number; newWords: number; heard: number; fallbacks: number; flags: number}
  days: ReportDay[]
  topWords: ReportWord[]
  newWords: ReportWord[]
  mistakes: {
    /** Words they reached for in the language they already read. */
    fallbacks: ReportWord[]
    /** Glossed 3+ times in the period: not sticking yet. */
    repeats: ReportWord[]
    flags: Array<{at: number; note: string; change?: string}>
    /** From the daily review; may be another speaker. */
    review: Array<{at: number; said: string; better: string; rule: string; confidence: "high" | "medium" | "low"}>
  }
}

/** A coding agent run started from the ask box. */
export interface CodeChange {
  status: "started" | "finished" | "failed"
  agentId?: string
  runId?: string
  /** The agent's closing summary, or why it failed. */
  detail?: string
  at: number
  finishedAt?: number
}

/**
 * One candidate interim-trigger rule, evaluated on the phone without sending
 * anything. Lets the Phase 1 thresholds be chosen from real speech instead of
 * shipped and then measured.
 */
export interface ShadowInterimObservation {
  utteranceId: string
  variant: "stable300" | "growth6"
  /** How much earlier than the ASR final this rule would have glossed. */
  leadMs: number
  /** The rule would have re-sent the last context, so the call was wasted. */
  wouldDuplicate: boolean
  charsAtTrigger: number
  charsAtFinal: number
}

export interface TranscriptRequest {
  text: string
  detectedLanguage?: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  mode: string
  disposition: TranscriptDisposition
  utteranceId?: string
  shadowInterim?: ShadowInterimObservation[]
  /**
   * How much earlier than this final the gloss actually ran, once interim
   * triggering is live. The realised counterpart to the shadow prediction.
   */
  asrLeadMs?: number
  /** Which bundle produced the shadow observations, so thresholds stay comparable. */
  clientVersion?: string
  clientBuildId?: string
}
