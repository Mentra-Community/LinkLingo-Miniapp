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
import {createLogger, diagnostics, logLevel} from "./observability"
import {loadSettings, saveSettings} from "./settings"
import {TranscriptBuffer} from "./TranscriptBuffer"

const log = createLogger("controller")

/** How often the running diagnostics snapshot is pushed to an open WebView. */
const DIAGNOSTICS_INTERVAL_MS = 5000

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
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null
  private uiOpen = false
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
        // Only log on transition so a persistent outage does not spam logcat
        // once per utterance.
        if (this.backend.status !== "error" || this.backend.lastError !== message) {
          log.warn("backend degraded", {message, previous: this.backend.status})
        }
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
    const started = Date.now()
    log.info("session starting", {logLevel})
    this.settings = await loadSettings(this.session)
    log.info("settings loaded", {
      source: this.settings.sourceLanguage,
      target: this.settings.targetLanguage,
      swap: this.settings.swapDirection,
      mode: this.settings.mode,
      proficiency: this.settings.proficiency,
      upgrades: this.settings.wordUpgrades,
      pinyin: this.settings.pinyinDisplay,
      lines: this.settings.displayLines,
      loadMs: Date.now() - started,
    })
    this.display.applySettings(this.settings)
    this.subscribeStreams()
    this.bindUi()
    this.session.ui.onOpen(() => {
      this.uiOpen = true
      diagnostics.increment("ui.opens")
      log.info("webview opened")
      this.ui.send("link:snapshot", this.snapshot())
      this.pushDiagnostics()
    })
    this.startDiagnosticsLoop()
    log.info("session ready", {startupMs: Date.now() - started})
  }

  /**
   * A phone has no log tail, so the running counters are pushed to the WebView
   * on an interval while it is open.
   */
  private startDiagnosticsLoop(): void {
    if (this.diagnosticsTimer) return
    this.diagnosticsTimer = setInterval(() => {
      if (this.uiOpen) this.pushDiagnostics()
    }, DIAGNOSTICS_INTERVAL_MS)
  }

  private pushDiagnostics(): void {
    try {
      this.ui.send("link:diagnostics", diagnostics.snapshot())
    } catch (err) {
      this.uiOpen = false
      log.debug("diagnostics push failed; assuming webview closed", {error: err as Error})
    }
  }

  private bindUi(): void {
    const on = <C extends keyof Channels>(channel: C, handler: (payload: Channels[C]) => void) => {
      this.session.ui.on(channel, (payload) => handler(payload as Channels[C]))
    }
    on("link:request-snapshot", () => {
      this.uiOpen = true
      this.ui.send("link:snapshot", this.snapshot())
      this.pushDiagnostics()
    })
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
      log.info("hud cleared by user")
      diagnostics.increment("ui.clears")
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
    const saveStarted = Date.now()
    try {
      await saveSettings(this.session, this.settings)
      diagnostics.observe("settings.saveMs", Date.now() - saveStarted)
    } catch (err) {
      // A failed write means the change is lost on next launch, which would
      // otherwise look like the setting silently refusing to stick.
      diagnostics.increment("settings.save_failures")
      log.error("failed to persist settings", {error: err as Error, changed: Object.keys(partial).join(",")})
    }
    diagnostics.increment("settings.changes")
    log.info("setting changed", {
      changed: Object.entries(partial)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(","),
    })
    this.display.applySettings(this.settings)
    const streamChanged =
      prev.mode !== this.settings.mode ||
      prev.sourceLanguage !== this.settings.sourceLanguage ||
      prev.targetLanguage !== this.settings.targetLanguage ||
      prev.swapDirection !== this.settings.swapDirection
    if (streamChanged) {
      log.info("resubscribing streams after settings change", {
        mode: `${prev.mode}->${this.settings.mode}`,
        listening: `${inputLanguage(prev)}->${inputLanguage(this.settings)}`,
      })
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
      } catch (err) {
        log.warn("stream cleanup threw", {error: err as Error})
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
        diagnostics.increment("streams.translation_fromTo")
        log.info("subscribed to translation stream", {source, target})
      } catch (err) {
        // The fallback drops the source pin, so recognition quality can change
        // without any user-visible signal.
        diagnostics.increment("streams.translation_fallback")
        log.error("translation fromTo failed; falling back to target-only", {source, target, error: err as Error})
        this.streamCleanup = this.session.translation.to(target, (data) => this.handleTranslation(data))
      }
      return
    }

    const language = toLocale(inputLanguage(this.settings))
    try {
      this.streamCleanup = this.session.transcription.forLanguage(language, (data) => {
        this.handleTranscription(data)
      })
      diagnostics.increment("streams.transcription_pinned")
      log.info("subscribed to transcription stream", {language, mode: this.settings.mode})
    } catch (err) {
      diagnostics.increment("streams.transcription_fallback")
      log.error("pinned transcription failed; falling back to auto-detect", {language, error: err as Error})
      this.streamCleanup = this.session.transcription.on((data) => this.handleTranscription(data))
    }
  }

  private handleTranscription(data: TranscriptionData): void {
    const text = data.text.trim()
    diagnostics.increment(data.isFinal ? "transcription.finals" : "transcription.interims")
    if (data.isFinal) {
      diagnostics.increment("transcription.finalChars", text.length)
      // Interims fire many times per second; only finals are worth a line.
      log.debug("final transcript", {
        chars: text.length,
        language: data.language,
        contextChars: this.buffer.context().length,
      })
      if (data.language && data.language !== toLocale(inputLanguage(this.settings))) {
        diagnostics.increment("transcription.language_mismatch")
        log.warn("transcript language differs from the configured input", {
          got: data.language,
          expected: toLocale(inputLanguage(this.settings)),
        })
      }
    }
    this.buffer.push(text, data.isFinal, data.language)
    this.caption = text
    this.display.showCaption(text, data.isFinal, this.settings, this.engine.currentWords(this.words, this.settings))
    this.ui.send("link:caption", {text, isFinal: data.isFinal})
    this.engine.consider(text, data.isFinal, this.settings)
  }

  private handleTranslation(data: TranslationData): void {
    const original = (data.originalText ?? "").trim()
    const translated = data.text.trim()
    diagnostics.increment(data.isFinal ? "translation.finals" : "translation.interims")
    if (data.isFinal) {
      log.debug("final translation", {
        originalChars: original.length,
        translatedChars: translated.length,
        source: data.sourceLanguage,
      })
      if (!translated) {
        diagnostics.increment("translation.empty")
        log.warn("translation stream returned empty text", {source: data.sourceLanguage})
      }
    }
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
