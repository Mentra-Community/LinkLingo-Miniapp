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
  geminiMs?: number
  model?: string
  clientRoundTripMs?: number
  /** Vocabulary size the backend assumed for the current proficiency setting. */
  knownRank?: number
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
  | "translation_mode"
  | "heard"
