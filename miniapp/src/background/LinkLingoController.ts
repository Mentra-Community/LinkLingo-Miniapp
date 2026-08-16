import type {MiniappSession, TranscriptionData, TranslationData, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  BackendStatus,
  GlossedWord,
  LinkLingoProfiling,
  LinkLingoSettings,
  LinkLingoSnapshot,
} from "../shared/types"
import {inputLanguage, outputLanguage} from "../shared/types"
import {DisplayRenderer} from "./DisplayRenderer"
import {GlossEngine} from "./GlossEngine"
import {toLocale} from "./locales"
import {loadSettings, saveSettings} from "./settings"
import {TranscriptBuffer} from "./TranscriptBuffer"

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

export class LinkLingoController {
  private settings!: LinkLingoSettings
  private words: GlossedWord[] = []
  private caption = ""
  private translation = ""
  private original = ""
  private processing = false
  private backend: BackendStatus = {status: "idle"}
  private profiling: LinkLingoProfiling | null = null
  private streamCleanup: UnsubscribeFn | null = null
  private readonly buffer = new TranscriptBuffer()
  private readonly display: DisplayRenderer
  private readonly engine: GlossEngine
  private readonly ui: {send: Send}

  constructor(private readonly session: MiniappSession) {
    this.ui = {
      send: (channel, payload) => this.session.ui.send(channel, payload),
    }
    this.display = new DisplayRenderer(session)
    this.engine = new GlossEngine(session, this.buffer, {
      onWords: (incoming) => {
        if (incoming.length > 0) {
          this.words = [...this.words, ...incoming].slice(-6)
        }
        const shown = this.engine.currentWords(this.words, this.settings)
        this.display.showWords(shown, this.settings)
        this.ui.send("link:words", shown)
      },
      onProfiling: (profiling) => {
        this.profiling = profiling
        this.backend = {status: profiling.model === "mock" ? "mock" : "ok"}
        this.ui.send("link:profiling", profiling)
        this.ui.send("link:backend-status", this.backend)
      },
      onBackendError: (message) => {
        this.backend = {status: "error", lastError: message}
        this.ui.send("link:backend-status", this.backend)
      },
      onProcessing: (processing) => {
        this.processing = processing
        this.ui.send("link:processing", {processing})
      },
    })
  }

  async start(): Promise<void> {
    this.settings = await loadSettings(this.session)
    this.display.applySettings(this.settings)
    this.subscribeStreams()
    this.bindUi()
    this.session.ui.onOpen(() => this.ui.send("link:snapshot", this.snapshot()))
  }

  private bindUi(): void {
    const on = <C extends keyof Channels>(channel: C, handler: (payload: Channels[C]) => void) => {
      this.session.ui.on(channel, (payload) => handler(payload as Channels[C]))
    }
    on("link:request-snapshot", () => this.ui.send("link:snapshot", this.snapshot()))
    on("link:set-source-language", ({language}) => void this.patch({sourceLanguage: language}))
    on("link:set-target-language", ({language}) => void this.patch({targetLanguage: language}))
    on("link:set-swap-direction", ({swapDirection}) => void this.patch({swapDirection}))
    on("link:set-proficiency", ({proficiency}) => void this.patch({proficiency}))
    on("link:set-mode", ({mode}) => void this.patch({mode}))
    on("link:set-word-upgrades", ({wordUpgrades}) => void this.patch({wordUpgrades}))
    on("link:set-display-lines", ({displayLines}) => void this.patch({displayLines}))
    on("link:set-display-width", ({displayWidth}) => void this.patch({displayWidth}))
    on("link:set-word-breaking", ({wordBreaking}) => void this.patch({wordBreaking}))
    on("link:set-pinyin-display", ({pinyinDisplay}) => void this.patch({pinyinDisplay}))
    on("link:clear", () => {
      this.words = []
      this.caption = ""
      this.translation = ""
      this.original = ""
      this.buffer.clear()
      this.engine.reset()
      this.display.clear()
      this.ui.send("link:snapshot", this.snapshot())
    })
  }

  private async patch(partial: Partial<LinkLingoSettings>): Promise<void> {
    const prev = this.settings
    this.settings = {...this.settings, ...partial}
    await saveSettings(this.session, this.settings)
    this.display.applySettings(this.settings)
    const streamChanged =
      prev.mode !== this.settings.mode ||
      prev.sourceLanguage !== this.settings.sourceLanguage ||
      prev.targetLanguage !== this.settings.targetLanguage ||
      prev.swapDirection !== this.settings.swapDirection
    if (streamChanged) {
      this.words = []
      this.caption = ""
      this.translation = ""
      this.original = ""
      this.buffer.clear()
      this.engine.reset()
      this.display.clear()
      this.subscribeStreams()
    }
    this.ui.send("link:settings-update", this.settings)
    this.ui.send("link:snapshot", this.snapshot())
  }

  private subscribeStreams(): void {
    if (this.streamCleanup) {
      try {
        this.streamCleanup()
      } catch {
        /* ignore */
      }
      this.streamCleanup = null
    }

    if (this.settings.mode === "translation") {
      const source = toLocale(inputLanguage(this.settings))
      const target = toLocale(outputLanguage(this.settings))
      try {
        this.streamCleanup = this.session.translation.fromTo(source, target, (data) => {
          this.handleTranslation(data)
        })
      } catch (err) {
        console.error("[linklingo] translation subscribe failed, falling back to to()", err)
        this.streamCleanup = this.session.translation.to(target, (data) => this.handleTranslation(data))
      }
      return
    }

    const language = toLocale(inputLanguage(this.settings))
    try {
      this.streamCleanup = this.session.transcription.forLanguage(language, (data) => {
        this.handleTranscription(data)
      })
    } catch (err) {
      console.error("[linklingo] transcription subscribe failed, falling back to auto", err)
      this.streamCleanup = this.session.transcription.on((data) => this.handleTranscription(data))
    }
  }

  private handleTranscription(data: TranscriptionData): void {
    const text = data.text.trim()
    this.buffer.push(text, data.isFinal, data.language)
    this.caption = text
    this.display.showCaption(text, data.isFinal, this.settings, this.engine.currentWords(this.words, this.settings))
    this.ui.send("link:caption", {text, isFinal: data.isFinal})
    this.engine.consider(text, data.isFinal, this.settings)
  }

  private handleTranslation(data: TranslationData): void {
    const original = (data.originalText ?? "").trim()
    const translated = data.text.trim()
    this.buffer.push(original || translated, data.isFinal, data.sourceLanguage)
    this.original = original
    this.translation = translated
    this.display.showTranslation(original, translated, this.settings)
    this.ui.send("link:translation", {original, translated, isFinal: data.isFinal})
  }

  private snapshot(): LinkLingoSnapshot {
    return {
      settings: this.settings,
      words: this.engine.currentWords(this.words, this.settings),
      caption: this.caption,
      translation: this.translation,
      original: this.original,
      processing: this.processing,
      backend: this.backend,
      profiling: this.profiling,
    }
  }
}
