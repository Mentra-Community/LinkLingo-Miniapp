import type {
  BackendStatus,
  FeedbackAnalysis,
  GlossedWord,
  LinkLingoDiagnostics,
  LinkLingoMode,
  LinkLingoProfiling,
  LinkLingoSettings,
  LinkLingoSnapshot,
} from "./types"
import type {SettingValue, View} from "./blocks"

export interface Channels {
  "link:snapshot": LinkLingoSnapshot
  "link:settings-update": LinkLingoSettings
  "link:words": GlossedWord[]
  "link:caption": {text: string; isFinal: boolean}
  "link:translation": {original: string; translated: string; isFinal: boolean}
  "link:processing": {processing: boolean}
  "link:backend-status": BackendStatus
  "link:profiling": LinkLingoProfiling
  "link:diagnostics": LinkLingoDiagnostics
  "link:request-snapshot": {}
  "link:set-source-language": {language: string}
  "link:set-target-language": {language: string}
  "link:set-swap-direction": {swapDirection: boolean}
  "link:set-proficiency": {proficiency: number}
  "link:set-mode": {mode: LinkLingoMode}
  "link:set-word-upgrades": {wordUpgrades: boolean}
  "link:set-display-lines": {displayLines: number}
  "link:set-display-width": {displayWidth: 0 | 1 | 2}
  "link:set-word-breaking": {wordBreaking: boolean}
  "link:set-pinyin-display": {pinyinDisplay: boolean}
  "link:set-interim-trigger": {interimTrigger: boolean}
  "link:set-fast-cooldown": {fastCooldown: boolean}
  /** A server-driven settings row changed; the background checks the key is one it may change. */
  "link:set-setting": {key: string; value: SettingValue}
  "link:clear": {}
  /** User flags a problem they just saw; background gathers context and asks the analyst. */
  "link:feedback": {requestId: string; note: string}
  "link:feedback-result": {requestId: string; ok: boolean; analysis?: FeedbackAnalysis; error?: string}
  /** A server-driven tab asks for its blocks; `screen` must be one the config lists. */
  "link:view-request": {requestId: string; screen: string; query: Record<string, string>}
  "link:view-result": {requestId: string; ok: boolean; view?: View; error?: string}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
