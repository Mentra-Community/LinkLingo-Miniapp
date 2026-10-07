/**
 * What the phone fetches at session start: extra settings rows, the numbers
 * its gloss loop runs on, and defaults for backend-only settings. Editing
 * this file and deploying changes every installed phone on its next launch,
 * with no new install.
 *
 * Built-in settings keys the phone can bind to are listed in
 * miniapp/src/background/settings.ts (SETTABLE_KEYS). Anything else must be
 * a `prefs.<name>` key, which the phone stores and sends back on every
 * request (read it with `currentRequestContext()?.prefs`).
 */

import {BLOCK_KIT_VERSION, type AppConfig, type ViewBlock} from "../ui-blocks"
import {digest} from "./review-log"
import {REPEAT_THRESHOLD} from "./history-report"

/**
 * Must stay within the phone's clamps (miniapp/src/background/tunables.ts);
 * out-of-range values are ignored there and the built-in default is kept.
 */
export const TUNABLES: Record<string, number> = {
  glossCooldownMs: 600,
  cooldownBypassChars: 8,
  interimStableMs: 300,
  interimGrowthChars: 6,
  wordTtlMs: 25_000,
  wordDedupMs: 20_000,
  reverseMaxWords: 2,
}

const SETTINGS: ViewBlock[] = [
  {
    type: "toggle",
    key: "reverseGloss",
    title: "Gloss my {output} too",
    detail: "When you fall back to {output} mid-sentence, show it in {input}",
    disabledWhen: {key: "mode", equals: "translation"},
  },
  {
    type: "select",
    key: "reverseKnownRank",
    title: "Skip the most common {output}",
    detail: "Words this frequent are never glossed back",
    options: [300, 500, 1000, 2000].map((rank) => ({value: rank, label: `Top ${rank.toLocaleString("en-US")}`})),
    visibleWhen: {key: "reverseGloss", equals: true},
  },
  {
    type: "select",
    key: "prefs.repeatThreshold",
    title: "Not sticking yet",
    detail: "In Reports, how often a word must come back to count",
    options: [2, 3, 4, 5].map((n) => ({value: n, label: `${n}+ times`})),
  },
]

const PREF_DEFAULTS = {repeatThreshold: REPEAT_THRESHOLD}

/** Each one needs a builder in backend/src/api/views.api.ts. */
const SCREENS: AppConfig["screens"] = [{id: "reports", title: "Reports", period: true}]

export function buildAppConfig(): AppConfig {
  const content = {tunables: TUNABLES, settings: SETTINGS, screens: SCREENS, prefDefaults: PREF_DEFAULTS}
  return {kit: BLOCK_KIT_VERSION, revision: digest(JSON.stringify(content)), ...content}
}
