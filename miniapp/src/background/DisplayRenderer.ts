import type {MiniappSession} from "@mentra/miniapp/background"

import {CaptionsFormatter, G1_PROFILE, type DisplayProfile} from "../core/CaptionsFormatter"
import {convertToPinyin} from "../core/ChineseUtils"
import type {GlossedWord, LinkLingoSettings} from "../shared/types"
import {HUD_CAPTION_LINES, HUD_WORD_ROWS, wordRowsFor} from "../shared/types"
import {createLogger, diagnostics} from "./observability"

const log = createLogger("display")

const INACTIVITY_MS = 40_000
export const IDLE_LINE = "LinkLingo · listening"
/**
 * A word slot with no word in it yet. A single space rather than an empty
 * string so the row survives any trimming between here and the glasses.
 */
export const EMPTY_ROW = " "
/**
 * Every send is a full EvenHub page rebuild over BLE on G2. Interim
 * transcription and translation events arrive ~10x/second, which saturates the
 * BLE queue ("writeCharacteristic ok=3 fail=2 in 3505ms"), makes the glasses
 * shut the page down, and leaves the HUD permanently blank. Coalesce instead.
 */
const MIN_SEND_INTERVAL_MS = 900

export class DisplayRenderer {
  private formatter: CaptionsFormatter
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private lastCaption = ""
  private lastTranslation = ""
  private lastOriginal = ""
  private lastWords: GlossedWord[] = []
  private lastSentText = ""
  private lastSentAt = 0
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSettings: LinkLingoSettings | null = null

  constructor(private readonly session: MiniappSession) {
    this.formatter = this.makeFormatter({
      displayLines: HUD_CAPTION_LINES,
      displayWidth: 1,
      wordBreaking: false,
    } as LinkLingoSettings)
  }

  applySettings(settings: LinkLingoSettings): void {
    this.formatter = this.makeFormatter(settings)
  }

  /** First frame so G2 brings the EvenHub page up before any speech arrives. */
  showIdle(settings: LinkLingoSettings): void {
    this.paint(settings)
  }

  showCaption(text: string, isFinal: boolean, settings: LinkLingoSettings, words: GlossedWord[]): void {
    const display = maybePinyin(text, settings)
    const formatted = this.formatter.processTranscription(display, isFinal)
    this.lastCaption = formatted.displayText
    this.lastWords = words
    this.paint(settings)
  }

  showTranslation(original: string, translated: string, settings: LinkLingoSettings): void {
    this.lastOriginal = maybePinyin(original, settings)
    this.lastTranslation = maybePinyin(translated, settings)
    this.paint(settings)
  }

  showWords(words: GlossedWord[], settings: LinkLingoSettings): void {
    this.lastWords = words
    this.paint(settings)
  }

  clear(settings: LinkLingoSettings): void {
    this.lastCaption = ""
    this.lastTranslation = ""
    this.lastOriginal = ""
    this.lastWords = []
    this.formatter.clear()
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    // Deliberately not session.display.clear(): a clear_view shuts the G2
    // EvenHub page down, and every later frame is then dropped. Repaint idle.
    this.paint(settings)
  }

  /**
   * Composes the frame, then hands it to the coalescing sender. Callers fire
   * this on every stream event, so it must stay cheap and must not touch BLE.
   */
  private paint(settings: LinkLingoSettings): void {
    this.pendingSettings = settings
    const text = this.compose(settings)

    if (text === this.lastSentText) {
      diagnostics.increment("display.deduped")
      return
    }

    const wait = MIN_SEND_INTERVAL_MS - (Date.now() - this.lastSentAt)
    if (wait <= 0) {
      this.send(text, settings)
      return
    }
    // A trailing timer already scheduled will pick up the newest state, so a
    // burst of interims collapses into one page rebuild.
    if (this.pendingTimer) return
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const latest = this.pendingSettings ?? settings
      const frame = this.compose(latest)
      if (frame !== this.lastSentText) this.send(frame, latest)
    }, wait)
  }

  /**
   * Always a single text_wall. Switching layoutType between text_wall and
   * double_text_wall is a structural change that forces G2 to tear the page
   * down and rebuild, which is why mode switches used to blank the glasses.
   */
  private compose(settings: LinkLingoSettings): string {
    return composeHud(
      {
        words: this.lastWords,
        caption: this.lastCaption,
        translation: this.lastTranslation,
        original: this.lastOriginal,
      },
      settings,
    )
  }

  private send(text: string, settings: LinkLingoSettings): void {
    const breakMode = settings.wordBreaking ? "character" : "word"
    // Do not pass durationMs. Mentra auto-clears that window, and on G2 a
    // clear_view shuts the EvenHub page down so the next frames never appear.
    const options = {breakMode: breakMode as "character" | "word"}
    const started = Date.now()

    try {
      this.session.display.showTextWall(text, options)
      diagnostics.increment("display.paints")
      diagnostics.observe("display.paintMs", Date.now() - started)
    } catch (err) {
      diagnostics.increment("display.paint_failures")
      log.error("display paint failed", {
        mode: settings.mode,
        wordRows: this.lastWords.length,
        error: err as Error,
      })
      return
    }

    this.lastSentText = text
    this.lastSentAt = Date.now()
    log.debug("painted hud", {
      mode: settings.mode,
      wordRows: this.lastWords.length,
      captionChars: this.lastCaption.trim().length,
      translationChars: this.lastTranslation.trim().length,
      sentChars: text.length,
      paintMs: Date.now() - started,
    })
    this.bumpInactivity(settings)
  }

  private bumpInactivity(settings: LinkLingoSettings): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer)
    this.inactivityTimer = setTimeout(() => {
      diagnostics.increment("display.inactivity_clears")
      log.info("idling hud after silence", {afterMs: INACTIVITY_MS})
      this.lastCaption = ""
      this.lastTranslation = ""
      this.lastOriginal = ""
      this.lastWords = []
      this.formatter.clear()
      // Keep the G2 page alive with a listening line instead of clear_view.
      this.paint(settings)
    }, INACTIVITY_MS)
  }

  private makeFormatter(settings: LinkLingoSettings): CaptionsFormatter {
    const profile: DisplayProfile = G1_PROFILE
    const widthScale = settings.displayWidth === 0 ? 0.7 : settings.displayWidth === 1 ? 0.85 : 1
    return new CaptionsFormatter(profile, {
      maxFinalTranscripts: 10,
      maxLines: Math.min(HUD_CAPTION_LINES, Math.max(1, settings.displayLines)),
      displayWidthPx: Math.floor(profile.displayWidthPx * widthScale),
      breakMode: settings.wordBreaking ? "character" : "word",
    })
  }
}

export interface HudState {
  words: GlossedWord[]
  caption: string
  translation: string
  original: string
}

/**
 * The frame the glasses show, as a pure function of state so it can be tested
 * without a session.
 *
 * Gloss modes always occupy the same rows:
 *   3 word slots
 *   1 blank gap
 *   3 caption slots
 * Empty slots are a single space so the glasses do not collapse them. A new
 * word or caption line fills a reserved slot instead of shoving the rest of
 * the page down.
 */
export function composeHud(state: HudState, settings: LinkLingoSettings): string {
  const wordRows = formatWords(state.words).slice(-HUD_WORD_ROWS)
  const captionLines = state.caption
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-HUD_CAPTION_LINES)
  const translation = state.translation.trim()
  const original = state.original.trim()

  if (settings.mode === "translation") {
    return joinRows([translation, original]) || IDLE_LINE
  }
  if (wordRows.length === 0 && captionLines.length === 0) return IDLE_LINE

  return [
    ...padRows(wordRows, wordRowsFor(settings.mode)),
    EMPTY_ROW,
    ...padRows(captionLines, HUD_CAPTION_LINES),
  ].join("\n")
}

function padRows(rows: string[], count: number): string[] {
  return [...rows, ...Array<string>(Math.max(0, count - rows.length)).fill(EMPTY_ROW)]
}

function joinRows(rows: string[]): string {
  return rows.filter((row) => row.length > 0).join("\n")
}

function formatWords(words: GlossedWord[]): string[] {
  return words.map((w) => `${w.isUpgrade ? "^ " : ""}${w.word} -> ${w.translation}`)
}

function maybePinyin(text: string, settings: LinkLingoSettings): string {
  if (!settings.pinyinDisplay) return text
  if (!/[\u4e00-\u9fff]/.test(text)) return text
  return convertToPinyin(text)
}
