export type LinkLingoMode = "gloss" | "gloss-captions" | "translation"

export interface LinkLingoSettings {
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

export const DEFAULT_SETTINGS: LinkLingoSettings = {
  sourceLanguage: "en",
  targetLanguage: "zh",
  swapDirection: false,
  proficiency: 33,
  mode: "gloss-captions",
  wordUpgrades: false,
  displayLines: 2,
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
}

export interface BackendStatus {
  status: "idle" | "ok" | "error" | "mock"
  lastError?: string
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
