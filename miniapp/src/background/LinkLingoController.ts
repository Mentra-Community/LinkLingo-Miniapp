import type {MiniappSession, TranscriptionData, TranslationData, UnsubscribeFn} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  BackendStatus,
  GlossedWord,
  LinkLingoProfiling,
  LinkLingoSettings,
  LinkLingoSnapshot,
  TranscriptDisposition,
} from "../shared/types"
import {inputLanguage, outputLanguage} from "../shared/types"
import {reportTranscript, requestFeedback} from "./backend"
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
  private wordExpiryTimer: ReturnType<typeof setTimeout> | null = null
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
        this.refreshWords()
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
    this.display.showIdle(this.settings)
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
   * Paints the words that are still live and arms a timer for the moment the
   * oldest one ages out, so a row disappears on schedule even when no new
   * speech arrives to trigger a repaint.
   */
  private refreshWords(): void {
    const now = Date.now()
    const shown = this.engine.currentWords(this.words, this.settings, now)
    this.display.showWords(shown, this.settings)
    this.ui.send("link:words", shown)

    if (this.wordExpiryTimer) {
      clearTimeout(this.wordExpiryTimer)
      this.wordExpiryTimer = null
    }
    const expiry = this.engine.nextExpiry(this.words, this.settings, now)
    if (expiry == null) return
    this.wordExpiryTimer = setTimeout(() => {
      this.wordExpiryTimer = null
      diagnostics.increment("engine.words_expired")
      this.refreshWords()
    }, Math.max(50, expiry - now))
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
    on("link:feedback", ({requestId, note}) => void this.askAnalyst(requestId, note))
    on("link:clear", () => {
      log.info("hud cleared by user")
      diagnostics.increment("ui.clears")
      if (this.wordExpiryTimer) {
        clearTimeout(this.wordExpiryTimer)
        this.wordExpiryTimer = null
      }
      this.words = []
      this.caption = ""
      this.translation = ""
      this.original = ""
      this.buffer.clear()
      this.engine.reset()
      this.display.clear(this.settings)
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
      this.display.applySettings(this.settings)
      this.display.showIdle(this.settings)
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
    // The buffer already correlates an interim with its final under one id,
    // which is what lets a shadow-interim observation be tied to the utterance
    // it would have glossed. TranscriptionData itself carries no id.
    const utterance = this.buffer.push(text, data.isFinal, data.language)
    this.caption = text
    this.display.showCaption(text, data.isFinal, this.settings, this.engine.currentWords(this.words, this.settings))
    this.ui.send("link:caption", {text, isFinal: data.isFinal})
    const disposition = this.engine.consider(text, data.isFinal, this.settings, utterance.id)
    if (data.isFinal && text && disposition) {
      this.recordTranscript(text, data.language, disposition, utterance.id)
    }
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
    const utterance = this.buffer.push(original || translated, data.isFinal, data.sourceLanguage)
    this.original = original
    this.translation = translated
    this.display.showTranslation(original, translated, this.settings)
    this.ui.send("link:translation", {original, translated, isFinal: data.isFinal})
    if (data.isFinal && (original || translated)) {
      this.recordTranscript(original || translated, data.sourceLanguage, "translation_mode", utterance.id)
    }
  }

  /**
   * "Something looked wrong just now." Ships the user's note with everything
   * the phone knows about the last half minute — utterances, the rows on the
   * glasses, settings — to the backend, which adds its own tape and asks the
   * analyst model for a diagnosis. The answer goes back to the WebView and is
   * archived server-side for later review.
   */
  private async askAnalyst(requestId: string, note: string): Promise<void> {
    diagnostics.increment("ui.feedback")
    log.info("feedback submitted", {chars: note.trim().length})
    const result = await requestFeedback(this.session, {
      note,
      settings: {
        inputLanguage: inputLanguage(this.settings),
        outputLanguage: outputLanguage(this.settings),
        proficiency: this.settings.proficiency,
        mode: this.settings.mode,
      },
      recentUtterances: this.buffer.list().map((u) => ({text: u.text, at: u.at, language: u.language})),
      shownWords: this.engine.currentWords(this.words, this.settings),
      recentWords: this.words,
      caption: this.caption,
      translation: this.translation,
      original: this.original,
    })
    if (!result.ok) {
      this.ui.send("link:feedback-result", {requestId, ok: false, error: result.message})
      return
    }
    this.ui.send("link:feedback-result", {requestId, ok: true, analysis: result.data})
  }

  private recordTranscript(
    text: string,
    detectedLanguage: string | undefined,
    disposition: TranscriptDisposition,
    utteranceId?: string,
  ): void {
    // Shadow results ride the transcript tape rather than the gloss tape:
    // they exist per utterance, including the many utterances that never
    // produce a gloss at all.
    const shadowInterim = this.engine.drainShadowObservations()
    reportTranscript(this.session, {
      text,
      detectedLanguage,
      inputLanguage: inputLanguage(this.settings),
      outputLanguage: outputLanguage(this.settings),
      fluencyLevel: this.settings.proficiency,
      mode: this.settings.mode,
      disposition,
      utteranceId,
      shadowInterim: shadowInterim.length > 0 ? shadowInterim : undefined,
    })
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
