/**
 * Words this learner has already been shown a gloss for.
 *
 * A repeated rare word costs a full round trip to produce the same two words
 * it produced last time. Serving it from disk puts it on the HUD immediately,
 * and the backend call still runs so the model can add whatever else is in
 * the utterance — the cache shortens the wait rather than replacing the model.
 *
 * Entries are keyed on the bare word plus the language pair, because the same
 * spelling glosses differently depending on which way the learner is going.
 */

import type {MiniappSession} from "@mentra/miniapp/background"

import type {GlossedWord} from "../shared/types"
import {createLogger, diagnostics} from "./observability"

const log = createLogger("cache")

const KEY = "linklingo:translations"
/** Roughly 60KB of JSON, comfortably inside the phone-storage guidance. */
const MAX_ENTRIES = 1500

interface CachedGloss {
  /** Annotated exactly as the backend returned it, so the HUD looks identical. */
  word: string
  translation: string
  at: number
}

export function cacheKey(bareWord: string, inputLanguage: string, outputLanguage: string): string {
  return `${bareWord.toLowerCase()}|${inputLanguage}|${outputLanguage}`
}

export class TranslationCache {
  /** Insertion order is the LRU order; re-setting a key moves it to the end. */
  private entries = new Map<string, CachedGloss>()
  private loaded = false
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly session: MiniappSession) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await this.session.storage.get(KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Record<string, CachedGloss>
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value.word === "string" && typeof value.translation === "string") {
          this.entries.set(key, value)
        }
      }
      log.info("translation cache loaded", {entries: this.entries.size})
    } catch (error) {
      // A corrupt cache is worth losing, never worth failing startup for.
      diagnostics.increment("cache.load_failures")
      log.warn("could not read translation cache; starting empty", {error: error as Error})
    }
  }

  get(bareWord: string, inputLanguage: string, outputLanguage: string): GlossedWord | null {
    const hit = this.entries.get(cacheKey(bareWord, inputLanguage, outputLanguage))
    if (!hit) return null
    return {word: hit.word, translation: hit.translation, at: Date.now()}
  }

  remember(words: GlossedWord[], inputLanguage: string, outputLanguage: string): void {
    for (const word of words) {
      const bare = bareWord(word.word)
      if (!bare || !word.translation) continue
      const key = cacheKey(bare, inputLanguage, outputLanguage)
      // Delete first so the re-insert moves it to the end of the LRU order.
      this.entries.delete(key)
      this.entries.set(key, {word: word.word, translation: word.translation, at: Date.now()})
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.dirty = true
    this.scheduleSave()
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Writes are debounced: a gloss can add three words at once, and storage is
   * a bridge call the background should not make on every utterance.
   */
  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 5_000)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    try {
      await this.session.storage.set(KEY, JSON.stringify(Object.fromEntries(this.entries)))
    } catch (error) {
      diagnostics.increment("cache.save_failures")
      log.warn("could not persist translation cache", {error: error as Error})
    }
  }
}

/** Strips the pinyin annotation the backend adds, which is not part of the identity. */
export function bareWord(word: string): string {
  return word.replace(/\s*\([^)]*\)/g, "").trim()
}
