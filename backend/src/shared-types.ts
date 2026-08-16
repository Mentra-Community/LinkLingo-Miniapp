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
