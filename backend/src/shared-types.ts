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

export interface GlossRequest {
  conversationContext: string
  inputLanguage: string
  outputLanguage: string
  fluencyLevel: number
  recentWords?: string[]
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
  /** Which bundle produced the shadow observations, so thresholds stay comparable. */
  clientVersion?: string
  clientBuildId?: string
}
