import type {MiniappSession} from "@mentra/miniapp/background"

import {utteranceInInputLanguage} from "../shared/script"
import type {
  GlossedWord,
  GlossQueueReason,
  LinkLingoProfiling,
  LinkLingoSettings,
  ShadowInterimObservation,
  TranscriptDisposition,
} from "../shared/types"
import {inputLanguage, outputLanguage, wordRowsFor} from "../shared/types"
import {requestGloss, requestUpgrade} from "./backend"
import {glossTelemetry} from "./glossTelemetry"
import {createLogger, diagnostics} from "./observability"
import {ShadowInterimDetector} from "./shadowInterim"
import {hasSentenceEnd, stripIncompleteLastWord, type TranscriptBuffer} from "./TranscriptBuffer"

const log = createLogger("engine")

const GLOSS_COOLDOWN_MS = 2000
const UPGRADE_COOLDOWN_MS = 8000
const WORD_DEDUP_MS = 20_000
const UPGRADE_DRAIN_MS = 5000
/**
 * A single ASR final is often a 2–6 character Chinese chunk ("我们去吃饭",
 * "然后那个功能"). The old 12-character floor treated those as noise, so most
 * speech never reached the model even though the buffer already held a
 * full phrase. 4 characters still drops 嗯/对/好/啊.
 */
const MIN_UTTERANCE_CHARS = 4
/** If this chunk is a filler, still gloss once the last 30s of speech is a phrase. */
const MIN_CONTEXT_CHARS = 8
/**
 * How long a glossed word stays on the HUD. Rows used to live until 40 s of
 * total silence, and every caption reset that clock, so during continuous
 * speech a gloss from minutes ago sat there looking stuck.
 */
export const WORD_TTL_MS = 25_000

export interface GlossEngineCallbacks {
  onWords(words: GlossedWord[]): void
  onProfiling(profiling: LinkLingoProfiling): void
  onBackendError(message: string): void
  onProcessing(processing: boolean): void
}

/** A gloss that became eligible, with the timing the request will be judged on. */
interface GlossAttempt {
  context: string
  /** Before cooldown, coalescing or in-flight blocking — the number Phase 1 must shrink. */
  eligibleAt: number
  utteranceId?: string
}

export class GlossEngine {
  private lastGlossAt = 0
  private lastUpgradeAt = 0
  private lastGlossContext = ""
  private glossInFlight = false
  private upgradeInFlight = false
  private pending: GlossAttempt | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private readonly shadow = new ShadowInterimDetector()
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

  consider(
    text: string,
    isFinal: boolean,
    settings: LinkLingoSettings,
    utteranceId?: string,
  ): TranscriptDisposition | null {
    if (settings.mode === "translation") return isFinal ? "translation_mode" : null
    const now = Date.now()
    // Speech in the learner's own language has nothing to gloss. Skipping it
    // here saves the round trip; the backend applies the same filter per
    // token for mixed contexts.
    if (!utteranceInInputLanguage(text, inputLanguage(settings), outputLanguage(settings))) {
      if (isFinal) {
        diagnostics.increment("engine.gloss_skipped.language_mismatch")
        log.debug("utterance is in the output language; not glossing", {chars: text.trim().length})
        return "skipped_language"
      }
      return null
    }
    // Measurement only: works out when the Phase 1 interim rules would have
    // fired, without sending anything or touching the HUD.
    if (utteranceId) {
      this.shadow.observe({utteranceId, text, isFinal, lastGlossContext: this.lastGlossContext, now})
    }
    const shouldGloss = shouldQueueGloss({
      text,
      isFinal,
      context: this.buffer.context(),
    })
    let disposition: TranscriptDisposition | null = isFinal ? "skipped_short" : null
    // `now` is the instant this transcript became eligible, captured before
    // queueGloss applies any cooldown or coalescing, so queueWaitMs measures
    // exactly the waiting Phase 1 sets out to remove.
    if (shouldGloss) disposition = this.queueGloss(settings, now, utteranceId)
    if (settings.wordUpgrades && now - this.lastUpgradeAt >= UPGRADE_COOLDOWN_MS) {
      void this.runUpgrade(settings)
    }
    return isFinal ? disposition : null
  }

  /** Shadow-interim observations whose final has landed; reported with the transcript tape. */
  drainShadowObservations(): ShadowInterimObservation[] {
    return this.shadow.drain()
  }

  currentWords(glossed: GlossedWord[], settings: LinkLingoSettings, now = Date.now()): GlossedWord[] {
    const maxGloss = wordRowsFor(settings.mode)
    const live = glossed.filter((w) => now - w.at <= WORD_TTL_MS)
    const glossRows = live.slice(-maxGloss)
    const upgrade = this.shownUpgrade && now - this.shownUpgrade.at <= WORD_TTL_MS ? this.shownUpgrade : null
    if (!settings.wordUpgrades || !upgrade) return glossRows
    const room = Math.max(0, maxGloss - 1)
    return [...glossRows.slice(-room), upgrade]
  }

  /** When the oldest visible word will age out, so the HUD can repaint then. Null when nothing is showing. */
  nextExpiry(glossed: GlossedWord[], settings: LinkLingoSettings, now = Date.now()): number | null {
    const shown = this.currentWords(glossed, settings, now)
    if (shown.length === 0) return null
    return Math.min(...shown.map((w) => w.at)) + WORD_TTL_MS
  }

  reset(): void {
    log.debug("engine reset", {
      recentWords: this.recent.size,
      queuedUpgrades: this.upgradeQueue.length,
    })
    diagnostics.increment("engine.resets")
    this.pending = null
    this.shadow.reset()
    this.lastGlossContext = ""
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.recent.clear()
    this.recentUpgrades = []
    this.upgradeQueue = []
    this.shownUpgrade = null
    if (this.upgradeTimer) {
      clearTimeout(this.upgradeTimer)
      this.upgradeTimer = null
    }
  }

  private queueGloss(
    settings: LinkLingoSettings,
    eligibleAt: number,
    utteranceId?: string,
  ): TranscriptDisposition {
    const context = this.contextForCall(false)
    if (!context) {
      diagnostics.increment("engine.gloss_skipped.no_context")
      return "skipped_short"
    }
    if (context === this.lastGlossContext) {
      diagnostics.increment("engine.gloss_skipped.duplicate")
      return "skipped_duplicate"
    }
    if (this.glossInFlight) {
      // Coalesced rather than dropped: the newest context replaces any older
      // pending one and runs as soon as the in-flight call returns.
      diagnostics.increment("engine.gloss_coalesced")
      log.debug("gloss coalesced behind in-flight call", {contextChars: context.length})
      this.pending = {context, eligibleAt, utteranceId}
      return "queued_gloss"
    }
    const sinceLast = eligibleAt - this.lastGlossAt
    if (sinceLast < GLOSS_COOLDOWN_MS) {
      // Dropped outright, not deferred, so the cost shows up as a missing
      // gloss in the transcript tape rather than as latency on a request.
      diagnostics.increment("engine.gloss_skipped.cooldown")
      log.debug("gloss suppressed by cooldown", {sinceLast, cooldownMs: GLOSS_COOLDOWN_MS})
      return "skipped_cooldown"
    }
    void this.runGloss(settings, {context, eligibleAt, utteranceId}, "none")
    return "queued_gloss"
  }

  private async runGloss(
    settings: LinkLingoSettings,
    attempt: GlossAttempt,
    queueReason: GlossQueueReason,
  ): Promise<void> {
    const {context} = attempt
    this.glossInFlight = true
    this.callbacks.onProcessing(true)
    this.lastGlossAt = Date.now()
    const result = await requestGloss(
      this.session,
      {
        conversationContext: context,
        inputLanguage: inputLanguage(settings),
        outputLanguage: outputLanguage(settings),
        fluencyLevel: settings.proficiency,
        recentWords: [...this.recent.keys()],
      },
      {eligibleAt: attempt.eligibleAt, queueReason, trigger: "final", utteranceId: attempt.utteranceId},
    )
    this.glossInFlight = false
    this.callbacks.onProcessing(false)
    this.lastGlossContext = context
    if (!result.ok) {
      this.callbacks.onBackendError(result.message)
      this.schedulePending(settings, context)
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
    // Closes the timing row: the frame is now with the display bridge, which
    // is as close to "on the glasses" as the phone can observe. Called even
    // when nothing was shown so the no-words path still reports a full span.
    if (result.data.profiling.requestId) {
      glossTelemetry.noteRendered(result.data.profiling.requestId)
    }
    this.schedulePending(settings, context)
  }

  /**
   * Empty glosses return in a couple of milliseconds. Draining the coalesced
   * context immediately turned one utterance into a 20-request storm. Wait out
   * the cooldown, and never re-send the same window.
   */
  private schedulePending(settings: LinkLingoSettings, justFinished: string): void {
    const next = this.pending
    if (!next) return
    this.pending = null
    if (next.context === justFinished || next.context === this.lastGlossContext) {
      diagnostics.increment("engine.gloss_skipped.duplicate")
      return
    }
    const wait = Math.max(0, GLOSS_COOLDOWN_MS - (Date.now() - this.lastGlossAt))
    // Distinguishes "waited on the clock" from "waited on the previous call",
    // so a long queueWaitMs names the mechanism that caused it.
    const reason: GlossQueueReason = wait > 0 ? "cooldown" : "coalesced"
    if (this.pendingTimer) clearTimeout(this.pendingTimer)
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      void this.runGloss(settings, next, reason)
    }, wait)
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

/**
 * Whether this transcript event should hit the gloss backend. Decides on the
 * current chunk *or* the accumulated buffer, so a stream of short Chinese
 * finals still produces translations.
 */
export function shouldQueueGloss(opts: {text: string; isFinal: boolean; context: string}): boolean {
  const current = opts.text.trim()
  if (!current) return false
  if (opts.isFinal) {
    return current.length >= MIN_UTTERANCE_CHARS || opts.context.trim().length >= MIN_CONTEXT_CHARS
  }
  return hasSentenceEnd(current) && stripIncompleteLastWord(current).length >= MIN_UTTERANCE_CHARS
}
