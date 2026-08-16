import type {MiniappSession} from "@mentra/miniapp/background"

import {CaptionsFormatter, G1_PROFILE, type DisplayProfile} from "../core/CaptionsFormatter"
import {convertToPinyin} from "../core/ChineseUtils"
import type {GlossedWord, LinkLingoSettings} from "../shared/types"

const INACTIVITY_MS = 40_000
const DISPLAY_MS = 20_000

export class DisplayRenderer {
  private formatter: CaptionsFormatter
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private lastCaption = ""
  private lastTranslation = ""
  private lastOriginal = ""
  private lastWords: GlossedWord[] = []

  constructor(private readonly session: MiniappSession) {
    this.formatter = this.makeFormatter({
      displayLines: 2,
      displayWidth: 1,
      wordBreaking: false,
    } as LinkLingoSettings)
  }

  applySettings(settings: LinkLingoSettings): void {
    this.formatter = this.makeFormatter(settings)
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

  clear(): void {
    this.lastCaption = ""
    this.lastTranslation = ""
    this.lastOriginal = ""
    this.lastWords = []
    this.formatter.clear()
    this.session.display.clear()
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  private paint(settings: LinkLingoSettings): void {
    const wordText = formatWords(this.lastWords)
    const breakMode = settings.wordBreaking ? "character" : "word"
    const options = {durationMs: DISPLAY_MS, breakMode: breakMode as "character" | "word"}

    if (settings.mode === "translation") {
      this.session.display.showDoubleTextWall(this.lastTranslation, this.lastOriginal, options)
    } else if (settings.mode === "gloss") {
      this.session.display.showTextWall(wordText, options)
    } else {
      this.session.display.showDoubleTextWall(wordText, this.lastCaption, options)
    }
    this.bumpInactivity()
  }

  private bumpInactivity(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer)
    this.inactivityTimer = setTimeout(() => {
      this.session.display.clear()
    }, INACTIVITY_MS)
  }

  private makeFormatter(settings: LinkLingoSettings): CaptionsFormatter {
    const profile: DisplayProfile = G1_PROFILE
    const widthScale = settings.displayWidth === 0 ? 0.7 : settings.displayWidth === 1 ? 0.85 : 1
    return new CaptionsFormatter(profile, {
      maxFinalTranscripts: 10,
      maxLines: settings.displayLines,
      displayWidthPx: Math.floor(profile.displayWidthPx * widthScale),
      breakMode: settings.wordBreaking ? "character" : "word",
    })
  }
}

function formatWords(words: GlossedWord[]): string {
  return words.map((w) => `${w.isUpgrade ? "^ " : ""}${w.word} -> ${w.translation}`).join("\n")
}

function maybePinyin(text: string, settings: LinkLingoSettings): string {
  if (!settings.pinyinDisplay) return text
  if (!/[\u4e00-\u9fff]/.test(text)) return text
  return convertToPinyin(text)
}
