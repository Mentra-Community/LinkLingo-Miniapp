/**
 * Server-driven UI: the backend describes a screen as blocks, the phone owns
 * how each block looks. A new screen, section or setting made from these
 * blocks ships with a backend deploy; only a new block type needs a new app.
 *
 * This file is mirrored byte for byte at miniapp/src/shared/blocks.ts, and a
 * test fails if the two drift. Edit both together.
 */

/** Bumped when a block type is added; the phone renders only what it knows and skips the rest. */
export const BLOCK_KIT_VERSION = 1

export type Tone = "default" | "accent" | "info" | "good" | "bad" | "muted"

export type SettingValue = string | number | boolean

/** Shows or disables a block depending on another setting, e.g. hide the cut when the toggle is off. */
export interface Condition {
  key: string
  equals?: SettingValue
  notEquals?: SettingValue
}

interface SettingBase {
  /** A built-in setting ("reverseGloss") or a backend-only one ("prefs.repeatThreshold"). */
  key: string
  title: string
  detail?: string
  visibleWhen?: Condition
  disabledWhen?: Condition
}

export type SettingBlock =
  | (SettingBase & {type: "toggle"})
  | (SettingBase & {type: "select"; options: Array<{value: SettingValue; label: string}>})
  | (SettingBase & {type: "slider"; min: number; max: number; step?: number})

export type ViewBlock =
  | {type: "section"; title?: string; meta?: string; blocks: ViewBlock[]}
  | {type: "tiles"; items: Array<{value: string | number; label: string}>}
  | {type: "bars"; label?: string; items: Array<{label: string; segments: Array<{value: number; tone?: Tone}>}>}
  | {
      type: "words"
      title?: string
      hint?: string
      empty?: string
      items: Array<{word: string; translation: string; badge?: string; tone?: Tone}>
    }
  | {
      type: "list"
      title?: string
      hint?: string
      empty?: string
      items: Array<{text: string; detail?: string; was?: string; tone?: Tone}>
    }
  | {type: "text"; text: string; tone?: "hint" | "body" | "error"}
  | SettingBlock

export interface View {
  kit: number
  title?: string
  blocks: ViewBlock[]
}

/**
 * Everything the phone takes from the server at session start. Text may use
 * `{input}` and `{output}`, replaced on the phone with the language names.
 */
export interface AppConfig {
  kit: number
  /** Changes whenever any of the content below does, so the phone can skip a re-render. */
  revision: string
  /** Numbers the phone's gloss loop reads instead of its built-in constants. */
  tunables: Record<string, number>
  /** Extra rows for the Learning card. */
  settings: ViewBlock[]
  /**
   * Tabs after Live. Each renders `GET /api/views/<id>`; `period` adds the
   * day/week picker and sends `range`, `date` and `tzOffsetMin`.
   */
  screens: Array<{id: string; title: string; period?: boolean}>
  /** Starting values for backend-only settings the phone has never seen. */
  prefDefaults: Record<string, SettingValue>
}
