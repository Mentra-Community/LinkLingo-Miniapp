import type {MiniappSession} from "@mentra/miniapp/background"

import type {GlossedWord, LinkLingoProfiling, LinkLingoSettings} from "../shared/types"
import {inputLanguage, outputLanguage} from "../shared/types"
import {requestGloss, requestUpgrade} from "./backend"
import {hasSentenceEnd, stripIncompleteLastWord, type TranscriptBuffer} from "./TranscriptBuffer"

const GLOSS_COOLDOWN_MS = 2000
const UPGRADE_COOLDOWN_MS = 8000
const WORD_DEDUP_MS = 20_000
const UPGRADE_DRAIN_MS = 5000
const MIN_FINAL_CHARS = 12

export interface GlossEngineCallbacks {
  onWords(words: GlossedWord[]): void
  onProfiling(profiling: LinkLingoProfiling): void
  onBackendError(message: string): void
  onProcessing(processing: boolean): void
}

export class GlossEngine {
  private lastGlossAt = 0
  private lastUpgradeAt = 0
  private glossInFlight = false
  private upgradeInFlight = false
  private pendingContext: string | null = null
  private recent = new Map<string, number>()
  private recentUpgrades: string[] = []
  private upgradeQueue: GlossedWord[] = []
  private upgradeTimer: ReturnType<typeof setTimeout> | null = null
  private shownUpgrade: GlossedWord | null = null

  constructor(
    private readonly session: MiniappSession,
    private readonly buffer: TranscriptBuffer,
    private readonly callbacks: GlossEngineCallbacks,
  ) {}

  consider(text: string, isFinal: boolean, settings: LinkLingoSettings): void {
    if (settings.mode === "translation") return
    const now = Date.now()
    const shouldGloss =
      (isFinal && text.trim().length >= MIN_FINAL_CHARS) ||
      (!isFinal && hasSentenceEnd(text) && stripIncompleteLastWord(text).length >= MIN_FINAL_CHARS)
    if (shouldGloss) this.queueGloss(settings, now)
    if (settings.wordUpgrades && now - this.lastUpgradeAt >= UPGRADE_COOLDOWN_MS) {
      void this.runUpgrade(settings)
    }
  }

  currentWords(glossed: GlossedWord[], settings: LinkLingoSettings): GlossedWord[] {
    const maxGloss = settings.mode === "gloss" ? 3 : 2
    const glossRows = glossed.slice(-maxGloss)
    if (!settings.wordUpgrades || !this.shownUpgrade) return glossRows
    const room = Math.max(0, maxGloss - 1)
    return [...glossRows.slice(-room), this.shownUpgrade]
  }

  reset(): void {
    this.pendingContext = null
    this.recent.clear()
    this.recentUpgrades = []
    this.upgradeQueue = []
    this.shownUpgrade = null
    if (this.upgradeTimer) {
      clearTimeout(this.upgradeTimer)
      this.upgradeTimer = null
    }
  }

  private queueGloss(settings: LinkLingoSettings, now: number): void {
    const context = this.contextForCall(false)
    if (!context) return
    if (this.glossInFlight) {
      this.pendingContext = context
      return
    }
    if (now - this.lastGlossAt < GLOSS_COOLDOWN_MS) return
    void this.runGloss(settings, context)
  }

  private async runGloss(settings: LinkLingoSettings, context: string): Promise<void> {
    this.glossInFlight = true
    this.callbacks.onProcessing(true)
    this.lastGlossAt = Date.now()
    const result = await requestGloss(this.session, {
      conversationContext: context,
      inputLanguage: inputLanguage(settings),
      outputLanguage: outputLanguage(settings),
      fluencyLevel: settings.proficiency,
      recentWords: [...this.recent.keys()],
    })
    this.glossInFlight = false
    this.callbacks.onProcessing(false)
    if (!result) {
      this.callbacks.onBackendError("gloss failed")
      return
    }
    this.callbacks.onProfiling(result.profiling)
    const now = Date.now()
    this.pruneRecent(now)
    const accepted: GlossedWord[] = []
    for (const word of result.words) {
      const key = bare(word.word)
      const last = this.recent.get(key)
      if (last && now - last < WORD_DEDUP_MS) continue
      this.recent.set(key, now)
      accepted.push({...word, at: now})
    }
    if (accepted.length > 0) this.callbacks.onWords(accepted)
    if (this.pendingContext) {
      const next = this.pendingContext
      this.pendingContext = null
      void this.runGloss(settings, next)
    }
  }

  private async runUpgrade(settings: LinkLingoSettings): Promise<void> {
    if (this.upgradeInFlight) return
    const context = this.contextForCall(true)
    if (!context) return
    this.upgradeInFlight = true
    this.lastUpgradeAt = Date.now()
    const result = await requestUpgrade(this.session, {
      conversationContext: context,
      inputLanguage: inputLanguage(settings),
      outputLanguage: outputLanguage(settings),
      fluencyLevel: settings.proficiency,
      recentUpgrades: this.recentUpgrades,
    })
    this.upgradeInFlight = false
    if (!result?.word || !result.meaning) return
    this.callbacks.onProfiling(result.profiling)
    this.recentUpgrades = [...this.recentUpgrades, result.word, result.meaning].slice(-12)
    this.upgradeQueue.push({
      word: result.word,
      translation: result.meaning,
      isUpgrade: true,
      at: Date.now(),
    })
    this.drainUpgradeQueue()
  }

  private drainUpgradeQueue(): void {
    if (this.upgradeTimer) return
    const next = () => {
      const item = this.upgradeQueue.shift()
      if (item) {
        this.shownUpgrade = item
        this.callbacks.onWords([])
      }
      if (this.upgradeQueue.length > 0) {
        this.upgradeTimer = setTimeout(next, UPGRADE_DRAIN_MS)
      } else {
        this.upgradeTimer = null
      }
    }
    next()
  }

  private contextForCall(keepLastWord: boolean): string {
    const raw = this.buffer.context()
    return keepLastWord ? raw : stripIncompleteLastWord(raw)
  }

  private pruneRecent(now: number): void {
    for (const [word, at] of this.recent) {
      if (now - at > WORD_DEDUP_MS) this.recent.delete(word)
    }
  }
}

function bare(word: string): string {
  return word.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()
}
