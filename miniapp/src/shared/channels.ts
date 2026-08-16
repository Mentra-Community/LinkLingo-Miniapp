import type {
  BackendStatus,
  GlossedWord,
  LinkLingoMode,
  LinkLingoProfiling,
  LinkLingoSettings,
  LinkLingoSnapshot,
} from "./types"

export interface Channels {
  "link:snapshot": LinkLingoSnapshot
  "link:settings-update": LinkLingoSettings
  "link:words": GlossedWord[]
  "link:caption": {text: string; isFinal: boolean}
  "link:translation": {original: string; translated: string; isFinal: boolean}
  "link:processing": {processing: boolean}
  "link:backend-status": BackendStatus
  "link:profiling": LinkLingoProfiling
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
  "link:clear": {}
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
