/**
 * Shadow evaluation of the Phase 1 interim trigger.
 *
 * Phase 1 wants to gloss before the ASR final arrives, on the theory that a
 * settled interim already contains the words worth glossing. Rather than ship
 * that and find out, 1.0.16 runs both candidate rules alongside the real
 * final-only path and records how much earlier each *would* have fired. No
 * request is sent and nothing reaches the HUD.
 *
 * Both rules are tracked independently per utterance so the report can compare
 * them: a rule that fires early but usually duplicates the final is worse than
 * one that fires later and always adds something.
 */

import type {ShadowInterimObservation} from "../shared/types"

/** Interim text unchanged for this long is treated as settled. */
const STABLE_MS = 300
/** Or: this many characters added since the last real gloss context. */
const GROWTH_CHARS = 6

export type ShadowVariant = ShadowInterimObservation["variant"]

interface Tracked {
  text: string
  /** When the current text was first seen, for the stability timer. */
  seenAt: number
  triggers: Partial<Record<ShadowVariant, {at: number; chars: number; text: string}>>
}

export class ShadowInterimDetector {
  private tracked = new Map<string, Tracked>()
  private completed: ShadowInterimObservation[] = []

  /**
   * Feed every transcription event. `now` is injected so the stability rule
   * can be evaluated deterministically in tests: an interim counts as stable
   * once a *later* event arrives while the text is unchanged.
   */
  observe(input: {
    utteranceId: string
    text: string
    isFinal: boolean
    /** The last context actually sent to the backend, for the duplicate check. */
    lastGlossContext: string
    now?: number
  }): void {
    const now = input.now ?? Date.now()
    const text = input.text.trim()
    const existing = this.tracked.get(input.utteranceId)

    if (input.isFinal) {
      if (existing) this.complete(input.utteranceId, existing, text, now, input.lastGlossContext)
      this.tracked.delete(input.utteranceId)
      this.prune()
      return
    }

    if (!existing) {
      this.tracked.set(input.utteranceId, {text, seenAt: now, triggers: {}})
      return
    }

    if (existing.text !== text) {
      // Growth is measured against the last thing the backend actually saw, so
      // a long utterance that was already glossed does not re-fire on every
      // keystroke of ASR output.
      const grown = text.length - input.lastGlossContext.trim().length
      if (!existing.triggers.growth6 && grown >= GROWTH_CHARS) {
        existing.triggers.growth6 = {at: now, chars: text.length, text}
      }
      existing.text = text
      existing.seenAt = now
      return
    }

    if (!existing.triggers.stable300 && now - existing.seenAt >= STABLE_MS) {
      existing.triggers.stable300 = {at: now, chars: text.length, text}
    }
  }

  /** Observations whose final has landed. Drains the buffer. */
  drain(): ShadowInterimObservation[] {
    if (this.completed.length === 0) return []
    const out = this.completed
    this.completed = []
    return out
  }

  reset(): void {
    this.tracked.clear()
    this.completed = []
  }

  private complete(
    utteranceId: string,
    tracked: Tracked,
    finalText: string,
    finalAt: number,
    lastGlossContext: string,
  ): void {
    for (const [variant, trigger] of Object.entries(tracked.triggers) as Array<
      [ShadowVariant, {at: number; chars: number; text: string}]
    >) {
      this.completed.push({
        utteranceId,
        variant,
        leadMs: Math.max(0, finalAt - trigger.at),
        wouldDuplicate: trigger.text === lastGlossContext.trim(),
        charsAtTrigger: trigger.chars,
        charsAtFinal: finalText.length,
      })
    }
    // Cap so a long session cannot grow this without bound if the phone never
    // manages to report (offline backend).
    if (this.completed.length > 200) this.completed = this.completed.slice(-200)
  }

  /** Utterances whose final never arrived would otherwise leak. */
  private prune(): void {
    if (this.tracked.size <= 20) return
    const ids = [...this.tracked.keys()].slice(0, this.tracked.size - 20)
    for (const id of ids) this.tracked.delete(id)
  }
}
