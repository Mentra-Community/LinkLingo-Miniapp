/**
 * What an installed phone lets the server change. Kept free of runtime
 * imports so the backend's tests can load it and check that every config
 * the server sends stays inside it.
 */

/** Built-in settings a server-driven block may bind to. Anything else must be `prefs.<name>`. */
export const SETTABLE_KEYS = [
  "reverseGloss",
  "reverseKnownRank",
  "wordUpgrades",
  "pinyinDisplay",
  "interimTrigger",
  "fastCooldown",
  "wordBreaking",
  "proficiency",
  "displayLines",
  "displayWidth",
] as const

export type SettableKey = (typeof SETTABLE_KEYS)[number]

/** Server tunables the gloss loop reads, with the range a value must fall in to be applied. */
export const TUNABLE_LIMITS: Record<string, readonly [number, number]> = {
  glossCooldownMs: [0, 5_000],
  cooldownBypassChars: [1, 100],
  interimStableMs: [50, 3_000],
  interimGrowthChars: [1, 50],
  wordTtlMs: [3_000, 120_000],
  wordDedupMs: [1_000, 300_000],
  reverseMaxWords: [1, 3],
}

export const DEFAULT_TUNABLES = {
  glossCooldownMs: 600,
  cooldownBypassChars: 8,
  interimStableMs: 300,
  interimGrowthChars: 6,
  wordTtlMs: 25_000,
  wordDedupMs: 20_000,
  reverseMaxWords: 2,
}

export type TunableName = keyof typeof DEFAULT_TUNABLES
