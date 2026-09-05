import type {MiniappSession} from "@mentra/miniapp/background"

import type {GlossedWord, LinkLingoProfiling, LinkLingoSettings} from "../shared/types"
import {inputLanguage, outputLanguage} from "../shared/types"
import {requestGloss, requestUpgrade} from "./backend"
import {createLogger, diagnostics} from "./observability"
import {hasSentenceEnd, stripIncompleteLastWord, type TranscriptBuffer} from "./TranscriptBuffer"

const log = createLogger("engine")

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
    log.debug("engine reset", {
      recentWords: this.recent.size,
      queuedUpgrades: this.upgradeQueue.length,
    })
    diagnostics.increment("engine.resets")
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
    if (!context) {
      diagnostics.increment("engine.gloss_skipped.no_context")
      return
    }
    if (this.glossInFlight) {
      // Coalesced rather than dropped: the newest context replaces any older
      // pending one and runs as soon as the in-flight call returns.
      diagnostics.increment("engine.gloss_coalesced")
      log.debug("gloss coalesced behind in-flight call", {contextChars: context.length})
      this.pendingContext = context
      return
    }
    const sinceLast = now - this.lastGlossAt
    if (sinceLast < GLOSS_COOLDOWN_MS) {
      diagnostics.increment("engine.gloss_skipped.cooldown")
      log.debug("gloss suppressed by cooldown", {sinceLast, cooldownMs: GLOSS_COOLDOWN_MS})
      return
    }
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
    if (!result.ok) {
      this.callbacks.onBackendError(result.message)
      return
    }
    this.callbacks.onProfiling(result.data.profiling)
    const now = Date.now()
    this.pruneRecent(now)
    const accepted: GlossedWord[] = []
    let deduped = 0
    for (const word of result.data.words) {
      const key = bare(word.word)
      const last = this.recent.get(key)
      if (last && now - last < WORD_DEDUP_MS) {
        deduped += 1
        continue
      }
      this.recent.set(key, now)
      accepted.push({...word, at: now})
    }

    if (deduped > 0) diagnostics.increment("engine.words_deduped", deduped)
    diagnostics.increment("engine.words_shown", accepted.length)
    log.info("gloss applied", {
      returned: result.data.words.length,
      shown: accepted.length,
      deduped,
      recentTracked: this.recent.size,
    })

    if (accepted.length > 0) this.callbacks.onWords(accepted)
    if (this.pendingContext) {
      const next = this.pendingContext
      this.pendingContext = null
      log.debug("running coalesced gloss")
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
    if (!result.ok) {
      this.callbacks.onBackendError(result.message)
      return
    }
    const {word, meaning, profiling} = result.data
    if (!word || !meaning) {
      diagnostics.increment("engine.upgrade_empty")
      return
    }
    diagnostics.increment("engine.upgrade_queued")
    this.callbacks.onProfiling(profiling)
    this.recentUpgrades = [...this.recentUpgrades, word, meaning].slice(-12)
    this.upgradeQueue.push({
      word,
      translation: meaning,
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
