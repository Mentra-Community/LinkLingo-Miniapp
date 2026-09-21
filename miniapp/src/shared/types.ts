export type LinkLingoMode = "gloss" | "gloss-captions" | "translation"

export interface LinkLingoSettings {
  schemaVersion?: number
  sourceLanguage: string
  targetLanguage: string
  swapDirection: boolean
  proficiency: number
  mode: LinkLingoMode
  wordUpgrades: boolean
  displayLines: number
  displayWidth: 0 | 1 | 2
  wordBreaking: boolean
  pinyinDisplay: boolean
  /**
   * Gloss from a settled interim instead of waiting for the ASR final. On by
   * default; exposed so one build can be A/B'd against the 1.0.16 baseline
   * without a reinstall.
   */
  interimTrigger: boolean
  /** Short gloss cooldown with a new-content bypass, versus the legacy 2s floor. */
  fastCooldown: boolean
}

export const SETTINGS_SCHEMA_VERSION = 3

/** Word rows the glasses always reserve. New words fill these slots; they never grow the page. */
export const HUD_WORD_ROWS = 3
/** Caption rows below the gap. The formatter may keep fewer; the frame is still this tall. */
export const HUD_CAPTION_LINES = 3

export const DEFAULT_SETTINGS: LinkLingoSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  sourceLanguage: "zh",
  targetLanguage: "en",
  swapDirection: false,
  proficiency: 33,
  mode: "gloss-captions",
  wordUpgrades: false,
  displayLines: HUD_CAPTION_LINES,
  displayWidth: 1,
  wordBreaking: false,
  pinyinDisplay: true,
  interimTrigger: true,
  fastCooldown: true,
}

export interface GlossedWord {
  word: string
  translation: string
  isUpgrade?: boolean
  at: number
}

/** Word slots shown on the HUD. Same count in every gloss mode so a mode switch does not jump. */
export function wordRowsFor(_mode: LinkLingoMode): number {
  return HUD_WORD_ROWS
}

export interface TranscriptLine {
  text: string
  isFinal: boolean
  language?: string
  at: number
}

export interface LinkLingoProfiling {
  totalMs?: number
  /** @deprecated Renamed to `llmMs`; kept so a 1.0.15 backend still renders. */
  geminiMs?: number
  llmMs?: number
  model?: string
  clientRoundTripMs?: number
  /** Vocabulary size the backend assumed for the current proficiency setting. */
  knownRank?: number
  /** Client-minted id; lets the WebView row be matched to a server tape entry. */
  requestId?: string
}

/** What made a gloss eligible. 1.0.16 only ever sends `final`; interims are shadow-only. */
export type GlossTrigger = "final" | "interim"

/**
 * Why a gloss waited between becoming eligible and being sent. Recorded where
 * the wait was imposed, so a large `queueWaitMs` can be blamed on the right
 * mechanism instead of guessed at.
 */
export type GlossQueueReason = "none" | "cooldown" | "in_flight" | "coalesced"

/** Timings for the gloss being sent right now. */
export interface GlossClientCurrent {
  requestId: string
  requestSeq: number
  utteranceId?: string
  trigger: GlossTrigger
  /** First moment this transcript could have glossed, before any waiting. */
  eligibleAt: number
  queueReason: GlossQueueReason
  queueWaitMs: number
  /** Since any previous request to the backend, so cold TLS is visible. */
  networkIdleMs?: number
}

/**
 * A complete, self-identifying snapshot of the *previous* gloss. A client only
 * learns its round trip after the response lands, so the numbers ride along
 * with the next request; carrying the id with them is what stops request N's
 * idle window being correlated with request N-1's round trip.
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

/** One variant of the proposed interim trigger, evaluated without sending anything. */
export interface ShadowInterimObservation {
  utteranceId: string
  /** Which candidate rule fired: stability timer or growth threshold. */
  variant: "stable300" | "growth6"
  /** How much earlier than the final this variant would have glossed. */
  leadMs: number
  /** True when the shadow context equalled the last real gloss, so the call would have been wasted. */
  wouldDuplicate: boolean
  charsAtTrigger: number
  charsAtFinal: number
}

/**
 * Estimated size of the learner's active vocabulary. Mirrors `knownRankFor` in
 * the backend so the slider can label itself with the same number the gloss
 * pipeline actually filters on.
 */
export function knownRankFor(proficiency: number): number {
  const raw = Number.isFinite(proficiency) ? proficiency : 50
  const p = Math.min(100, Math.max(0, raw)) / 100
  return Math.round(300 * Math.pow(50, p))
}

export interface BackendStatus {
  status: "idle" | "ok" | "error" | "mock"
  lastError?: string
}

export interface LinkLingoTiming {
  count: number
  avgMs: number
  lastMs: number
  maxMs: number
}

/** Running background counters, mirrored into the WebView for on-device inspection. */
export interface LinkLingoDiagnostics {
  startedAt: number
  uptimeSeconds: number
  counters: Record<string, number>
  timings: Record<string, LinkLingoTiming>
  lastError: string | null
  lastErrorAt: number | null
}

export interface LinkLingoSnapshot {
  settings: LinkLingoSettings
  words: GlossedWord[]
  caption: string
  translation: string
  original: string
  processing: boolean
  backend: BackendStatus
  profiling: LinkLingoProfiling | null
}

export function inputLanguage(settings: LinkLingoSettings): string {
  return settings.swapDirection ? settings.targetLanguage : settings.sourceLanguage
}

export function outputLanguage(settings: LinkLingoSettings): string {
  return settings.swapDirection ? settings.sourceLanguage : settings.targetLanguage
}

/** The analyst's plain-text reply to a comment about recent translations. */
export interface FeedbackAnalysis {
  id: string
  model: string
  answer: string
  totalMs: number
}

/** Why a final utterance did or did not go to the gloss backend. */
export type TranscriptDisposition =
  | "queued_gloss"
  | "skipped_language"
  | "skipped_short"
  | "skipped_duplicate"
  | "skipped_cooldown"
  /** The phone decided locally that nothing here is above the learner's vocabulary. */
  | "skipped_no_candidates"
  | "translation_mode"
  | "heard"
