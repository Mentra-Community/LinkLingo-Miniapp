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
import {DEFAULT_CONFIG} from "../shared/defaultConfig"
import type {AppConfig} from "../shared/blocks"
import {preconnect, reportTranscript, requestConfig, requestFeedback, requestView, setPrefs} from "./backend"
import {CONFIG_STALE_MS, loadCachedConfig, saveConfig, validConfig} from "./remoteConfig"
import {applyTunables} from "./tunables"
import {DisplayRenderer} from "./DisplayRenderer"
import {GlossEngine} from "./GlossEngine"
import {toLocale} from "./locales"
import {CLIENT_BUILD_ID, CLIENT_VERSION} from "./identity"
import {LearningCapture, captureModeFor, type EnqueueResult} from "./learningCapture"
import {createLearningTransport, learningUrl, type LearningTransport} from "./learningTransport"
import {createLogger, diagnostics, logLevel} from "./observability"
import {cleanPrefs, loadSettings, normalizeSettings, saveSettings, settingPatch} from "./settings"
import {extractSaveForLater} from "./saveForLater"
import {TranscriptBuffer} from "./TranscriptBuffer"
import {TranslationCache} from "./translationCache"

const log = createLogger("controller")

/** How often the running diagnostics snapshot is pushed to an open WebView. */
const DIAGNOSTICS_INTERVAL_MS = 5000
/**
 * Keeps the backend connection from going idle during a conversation. Short
 * enough to stay under a typical proxy idle timeout, so the next gloss finds
 * the socket already open.
 */
const KEEPALIVE_INTERVAL_MS = 25_000

/** How often the learning loop checks in: phone-status heartbeat, and the status poll when it is due. */
const LEARNING_TICK_MS = 60_000
/** The backend's view of the pairing is refreshed this often while capture is on. */
const LEARNING_STATUS_POLL_MS = 5 * 60_000
/** Status changes are reported at most this often. */
const PHONE_STATUS_MIN_GAP_MS = 10_000

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

export class LinkLingoController {
  private settings!: LinkLingoSettings
  private config: AppConfig = DEFAULT_CONFIG
  private configFetchedAt = 0
  private words: GlossedWord[] = []
  private caption = ""
  private translation = ""
  private original = ""
  private lastFinalText = ""
  private recentFinals: string[] = []
  private processing = false
  private backend: BackendStatus = {status: "idle"}
  private profiling: LinkLingoProfiling | null = null
  private streamCleanup: UnsubscribeFn | null = null
  private diagnosticsTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private wordExpiryTimer: ReturnType<typeof setTimeout> | null = null
  private uiOpen = false
  private readonly learning: LearningCapture
  private readonly learningTransport: LearningTransport
  private learningServerEnabled = true
  private learningStatusAt = 0
  private learningTimer: ReturnType<typeof setInterval> | null = null
  private phoneStatusTimer: ReturnType<typeof setTimeout> | null = null
  private phoneStatusKey = ""
  private phoneStatusAt = 0
  private readonly buffer = new TranscriptBuffer()
  private readonly display: DisplayRenderer
  private readonly cache: TranslationCache
  private readonly engine: GlossEngine
  private readonly ui: {send: Send}

  constructor(
    private readonly session: MiniappSession,
    deps: {learning?: LearningCapture; learningTransport?: LearningTransport} = {},
  ) {
    this.learningTransport =
      deps.learningTransport ??
      createLearningTransport({authFetch: (path, init) => session.auth.fetch(learningUrl(path), init)})
    this.learning =
      deps.learning ??
      new LearningCapture({
        storage: {
          get: (key) => session.storage.get(key),
          set: (key, value) => session.storage.set(key, value),
          delete: (key) => session.storage.delete(key),
          keys: () => session.storage.keys(),
        },
        send: (events) => this.learningTransport.send(events),
        clientVersion: CLIENT_VERSION,
        clientBuildId: CLIENT_BUILD_ID,
      })
    this.ui = {
      send: (channel, payload) => this.session.ui.send(channel, payload),
    }
    this.display = new DisplayRenderer(session)
    this.cache = new TranslationCache(session)
    this.engine = new GlossEngine(
      session,
      this.buffer,
      {
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
      },
      this.cache,
    )
  }

  async start(): Promise<void> {
    const started = Date.now()
    log.info("session starting", {logLevel})
    this.settings = await loadSettings(this.session)
    // The last config the server sent, or the bundled one. Applied before the
    // first utterance; the fresh copy arrives in the background.
    this.applyConfig(await loadCachedConfig(this.session))
    void this.refreshConfig()
    // Read before the first utterance so an early repeat is already a hit.
    await this.cache.load()
    // Restores the durable queue before the first utterance can arrive; never blocks captions on delivery.
    await this.startLearning()
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
      this.learningForeground()
      this.ui.send("link:snapshot", this.snapshot())
      this.pushDiagnostics()
    })
    this.startDiagnosticsLoop()
    this.startKeepaliveLoop()
    // Opens the connection before the first utterance rather than letting the
    // first gloss of the session absorb the handshake.
    preconnect(true)
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
    this.wordExpiryTimer = setTimeout(
      () => {
        this.wordExpiryTimer = null
        diagnostics.increment("engine.words_expired")
        this.refreshWords()
      },
      Math.max(50, expiry - now),
    )
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

  /**
   * Holds the backend connection open for the life of the session. Without
   * it, the first gloss after any pause in the conversation pays a full TLS
   * handshake, which from Asia is comparable to the gloss itself.
   */
  private startKeepaliveLoop(): void {
    if (this.keepaliveTimer) return
    this.keepaliveTimer = setInterval(() => preconnect(), KEEPALIVE_INTERVAL_MS)
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
      if (Date.now() - this.configFetchedAt > CONFIG_STALE_MS) void this.refreshConfig()
    })
    on("link:set-setting", ({key, value}) => {
      const partial = settingPatch(this.settings, key, value)
      if (!partial) {
        diagnostics.increment("settings.rejected_remote_key")
        log.warn("ignored a setting this build cannot change", {key})
        // The WebView may already show the change; put it back in step.
        this.ui.send("link:settings-update", this.settings)
        return
      }
      void this.patch(partial)
    })
    on("link:view-request", ({requestId, screen, query}) => {
      if (!this.config.screens.some((s) => s.id === screen)) {
        this.ui.send("link:view-result", {requestId, ok: false, error: "Unknown screen"})
        return
      }
      void requestView(this.session, screen, query).then((result) =>
        this.ui.send(
          "link:view-result",
          result.ok ? {requestId, ok: true, view: result.data} : {requestId, ok: false, error: result.message},
        ),
      )
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
    on("link:set-interim-trigger", ({interimTrigger}) => void this.patch({interimTrigger}))
    on("link:set-fast-cooldown", ({fastCooldown}) => void this.patch({fastCooldown}))
    on("link:feedback", ({requestId, note}) => void this.askAnalyst(requestId, note))
    on("link:save-for-later", ({requestId, text}) => {
      const heard = this.recentFinals
      const previous = heard.at(-1) ?? ""
      const contextBefore = previous.trim() && previous.trim() !== text.trim() ? previous : (heard.at(-2) ?? "")
      void this.saveForLater(text, "typed", requestId, undefined, undefined, contextBefore)
    })
    on("link:learning-pair", ({requestId, code}) => void this.pairLearning(requestId, code))
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
      this.lastFinalText = ""
      this.recentFinals = []
      this.buffer.clear()
      this.engine.reset()
      this.display.clear(this.settings)
      this.ui.send("link:snapshot", this.snapshot())
    })
  }

  /** Tunables and pref defaults from the server; prefs the learner already set win over defaults. */
  private applyConfig(config: AppConfig): void {
    this.config = config
    const applied = applyTunables(config.tunables)
    const prefs = cleanPrefs({...config.prefDefaults, ...this.settings.prefs})
    this.settings = {...this.settings, prefs}
    setPrefs(prefs)
    log.info("config applied", {revision: config.revision, tunables: applied.length, screens: config.screens.length})
  }

  private async refreshConfig(): Promise<void> {
    this.configFetchedAt = Date.now()
    const result = await requestConfig(this.session)
    if (!result.ok) {
      log.warn("config fetch failed; keeping the last good copy", {message: result.message})
      return
    }
    const fresh = validConfig(result.data)
    if (!fresh) {
      diagnostics.increment("config.rejected")
      log.warn("server config was malformed; keeping the last good copy")
      return
    }
    if (fresh.revision === this.config.revision) return
    this.applyConfig(fresh)
    await saveConfig(this.session, fresh)
    diagnostics.increment("config.updates")
    if (this.uiOpen) this.ui.send("link:snapshot", this.snapshot())
  }

  private async patch(partial: Partial<LinkLingoSettings>): Promise<void> {
    const prev = this.settings
    // Normalized because server-driven rows can now set values this build never offered.
    this.settings = normalizeSettings({...this.settings, ...partial})
    if (partial.prefs) setPrefs(this.settings.prefs)
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
    if (prev.learningCapture !== this.settings.learningCapture) this.onLearningToggled()
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
      this.lastFinalText = ""
      this.recentFinals = []
      this.buffer.clear()
      this.engine.reset()
      this.display.applySettings(this.settings)
      this.display.showIdle(this.settings)
      this.subscribeStreams()
    }
    this.ui.send("link:settings-update", this.settings)
    this.ui.send("link:snapshot", this.snapshot())
  }

  /** Wraps stream setup so each successful (re)subscription is one learning "listening run". */
  private subscribeStreams(): void {
    this.learning.setListening(false)
    this.openStreams()
    this.learning.startSession()
    this.learning.setListening(true)
  }

  private openStreams(): void {
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
    if (data.isFinal && text) {
      const save = extractSaveForLater(text, this.lastFinalText)
      if (save) {
        diagnostics.increment("learning.save_voice_detected")
        const contextBefore = save.usedPrevious
          ? (this.recentFinals[this.recentFinals.length - 2] ?? "")
          : (this.recentFinals[this.recentFinals.length - 1] ?? "")
        this.lastFinalText = save.text
        this.caption = `Saving for later: ${save.text}`
        this.display.showCaption(this.caption, true, this.settings, this.engine.currentWords(this.words, this.settings))
        this.ui.send("link:caption", {text: this.caption, isFinal: true})
        void this.saveForLater(save.text, "voice", undefined, data.language, data.speakerId, contextBefore)
        return
      }
      this.lastFinalText = text
      this.recentFinals = [...this.recentFinals, text].slice(-4)
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
      this.recordTranscript(text, data.language, disposition, utterance.id, data.text, data.speakerId)
    } else if (data.isFinal && text) {
      // The engine gave no disposition for a final; the utterance is still worth keeping.
      this.captureLearning(text, data.language, "heard", utterance.id, data.text)
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
      this.recordTranscript(
        original || translated,
        data.sourceLanguage,
        "translation_mode",
        utterance.id,
        original ? (data.originalText ?? original) : data.text,
        data.speakerId,
      )
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

  /**
   * Explicit saves bypass the passive-capture toggle. They are written to the
   * phone queue immediately and sync when a Mandarin connection exists.
   */
  private async saveForLater(
    text: string,
    source: "voice" | "typed",
    requestId?: string,
    detectedLanguage?: string,
    speakerId?: string,
    contextBefore = "",
  ): Promise<void> {
    const sentence = text.trim()
    if (!sentence) {
      if (requestId) this.ui.send("link:save-for-later-result", {requestId, ok: false, message: "Enter a sentence."})
      return
    }
    diagnostics.increment(`learning.save_${source}`)
    try {
      const result = await this.learning.enqueue({
        text: sentence,
        explicit: true,
        language: detectedLanguage,
        inputLanguage: inputLanguage(this.settings),
        outputLanguage: outputLanguage(this.settings),
        mode: "reverse",
        disposition: "save_for_later",
        contextBefore,
      })
      const ok = result.status === "queued"
      const offline = ok && this.learning.status().state === "not_connected"
      const message = offline
        ? "Saved on this phone. It will sync when Mandarin is connected."
        : saveResultMessage(result.status)
      if (ok && source === "voice") {
        reportTranscript(this.session, {
          text: sentence,
          detectedLanguage,
          inputLanguage: inputLanguage(this.settings),
          outputLanguage: outputLanguage(this.settings),
          fluencyLevel: this.settings.proficiency,
          mode: "reverse",
          disposition: "save_for_later",
          speakerId,
        })
      }
      if (source === "voice") {
        this.caption = ok ? `Saved for later: ${sentence}` : message
        this.display.showCaption(this.caption, true, this.settings, this.engine.currentWords(this.words, this.settings))
        this.ui.send("link:caption", {text: this.caption, isFinal: true})
      }
      if (requestId) this.ui.send("link:save-for-later-result", {requestId, ok, message})
      diagnostics.increment(`learning.save_${ok ? "queued" : result.status}`)
    } catch (err) {
      diagnostics.increment("learning.save_errors")
      log.warn("explicit save failed", {error: err as Error})
      const message = "Couldn't save that sentence. Try again from the phone."
      if (source === "voice") {
        this.caption = message
        this.display.showCaption(this.caption, true, this.settings, this.engine.currentWords(this.words, this.settings))
        this.ui.send("link:caption", {text: this.caption, isFinal: true})
      }
      if (requestId) this.ui.send("link:save-for-later-result", {requestId, ok: false, message})
    }
  }

  private recordTranscript(
    text: string,
    detectedLanguage: string | undefined,
    disposition: TranscriptDisposition,
    utteranceId?: string,
    rawText?: string,
    speakerId?: string,
  ): void {
    // Durable capture comes first and is fully isolated: it must never throw into the caption path.
    this.captureLearning(text, detectedLanguage, disposition, utteranceId, rawText)
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
      speakerId,
      shadowInterim: shadowInterim.length > 0 ? shadowInterim : undefined,
      // Only present when this utterance was glossed from an interim; it is
      // the realised version of what shadow mode predicted.
      asrLeadMs: this.engine.takeAsrLeadMs(),
    })
  }

  /**
   * Hands one final segment to the durable queue. Fire-and-forget: the caption
   * path never waits on storage or delivery, and nothing thrown here escapes.
   * A no-op unless the learningCapture setting is on; the queue itself also
   * requires a paired backend connection.
   */
  private captureLearning(
    text: string,
    detectedLanguage: string | undefined,
    disposition: TranscriptDisposition,
    utteranceId?: string,
    rawText?: string,
  ): void {
    try {
      if (!this.settings.learningCapture) return
      diagnostics.increment("learning.hook_calls")
      void this.learning
        .enqueue({
          text: rawText ?? text,
          language: detectedLanguage,
          inputLanguage: inputLanguage(this.settings),
          outputLanguage: outputLanguage(this.settings),
          mode: captureModeFor(this.settings.mode, disposition),
          disposition,
          utteranceId,
        })
        .then(
          (result) => diagnostics.increment(`learning.enqueue_${result.status}`),
          () => diagnostics.increment("learning.hook_errors"),
        )
    } catch (err) {
      diagnostics.increment("learning.hook_errors")
      log.warn("learning capture hook failed", {error: err as Error})
    }
  }

  private async startLearning(): Promise<void> {
    try {
      await this.learning.init()
      this.applyLearningEnabled()
      this.learning.onChange(() => this.schedulePhoneStatus())
      try {
        // A refreshed token is the usual fix for a 401 stop.
        this.session.auth.onUpdate(() => void this.learning.retryNow())
      } catch (err) {
        log.debug("auth updates unavailable for learning retries", {error: err as Error})
      }
      void this.refreshLearningStatus()
      if (!this.learningTimer) this.learningTimer = setInterval(() => this.learningTick(), LEARNING_TICK_MS)
    } catch (err) {
      diagnostics.increment("learning.start_failures")
      log.error("learning capture failed to start; captions are unaffected", {error: err as Error})
    }
  }

  /** Capture runs only while the learner has it on and the server has not switched the feature off. */
  private applyLearningEnabled(): void {
    this.learning.setEnabled(this.settings.learningCapture && this.learningServerEnabled)
  }

  private onLearningToggled(): void {
    this.applyLearningEnabled()
    if (this.settings.learningCapture) void this.refreshLearningStatus()
    this.schedulePhoneStatus()
  }

  /** Sets the connected state from the backend. A failed poll keeps the last known state: an outage must not look like an unpair. */
  private async refreshLearningStatus(): Promise<void> {
    try {
      const result = await this.learningTransport.fetchStatus()
      this.learningStatusAt = Date.now()
      if (!result.ok) {
        diagnostics.increment("learning.status_failures")
        return
      }
      this.learningServerEnabled = result.status.enabled
      this.learning.setConnected(result.status.connected)
      this.applyLearningEnabled()
      if (result.status.connected) void this.learning.drain()
      this.schedulePhoneStatus()
    } catch (err) {
      diagnostics.increment("learning.status_failures")
      log.warn("learning status poll threw", {error: err as Error})
    }
  }

  /** The learner pasted a pairing code from the Mandarin app. On success the connection state is re-read right away. */
  private async pairLearning(requestId: string, code: string): Promise<void> {
    try {
      const outcome = await this.learningTransport.pair(code)
      this.ui.send("link:learning-pair-result", {requestId, ok: outcome.ok, message: outcome.message})
      if (outcome.ok) {
        diagnostics.increment("learning.paired")
        await this.refreshLearningStatus()
      } else {
        diagnostics.increment("learning.pair_failed")
      }
    } catch (err) {
      diagnostics.increment("learning.pair_errors")
      log.warn("learning pairing failed", {error: err as Error})
      this.ui.send("link:learning-pair-result", {requestId, ok: false, message: "Pairing failed. Try again."})
    }
  }

  private learningForeground(): void {
    try {
      const status = this.learning.status()
      if (this.settings.learningCapture || status.pending > 0) {
        void this.learning.retryNow().catch(() => diagnostics.increment("learning.foreground_drain_failures"))
        if (Date.now() - this.learningStatusAt > LEARNING_TICK_MS) void this.refreshLearningStatus()
      }
    } catch (err) {
      diagnostics.increment("learning.foreground_errors")
      log.warn("learning foreground hook failed", {error: err as Error})
    }
  }

  private learningTick(): void {
    try {
      const status = this.learning.status()
      const active = this.settings.learningCapture || status.pending > 0
      if (active && Date.now() - this.learningStatusAt >= LEARNING_STATUS_POLL_MS) void this.refreshLearningStatus()
      if (active) void this.postPhoneStatus(true)
    } catch (err) {
      diagnostics.increment("learning.tick_errors")
      log.warn("learning tick failed", {error: err as Error})
    }
  }

  /** Reports a status change soon, but never more often than the throttle. */
  private schedulePhoneStatus(): void {
    if (this.phoneStatusTimer) return
    const wait = Math.max(0, PHONE_STATUS_MIN_GAP_MS - (Date.now() - this.phoneStatusAt))
    this.phoneStatusTimer = setTimeout(() => {
      this.phoneStatusTimer = null
      void this.postPhoneStatus(false)
    }, wait)
  }

  /** Best-effort `POST /api/learning/phone-status`: on change, and as a 60s heartbeat while active. */
  private async postPhoneStatus(heartbeat: boolean): Promise<void> {
    const status = this.learning.status()
    if (status.state === "not_connected") return
    // Pending moves with every utterance; it rides the heartbeat instead of triggering a post of its own.
    const key = JSON.stringify([
      status.state,
      status.pending > 0,
      status.gaps.length,
      status.quarantined,
      status.lastError,
    ])
    const now = Date.now()
    const changed = key !== this.phoneStatusKey
    if (!changed && !(heartbeat && now - this.phoneStatusAt >= LEARNING_TICK_MS)) return
    if (changed && !this.phoneStatusKey && !this.settings.learningCapture && status.pending === 0) return
    this.phoneStatusKey = key
    this.phoneStatusAt = now
    const ok = await this.learningTransport.postPhoneStatus({
      state: status.state,
      pending: status.pending,
      gaps: status.gaps,
      quarantined: status.quarantined,
      lastError: status.lastError,
    })
    if (!ok) {
      diagnostics.increment("learning.phone_status_failures")
      this.phoneStatusKey = "" // try again on the next change or heartbeat
    }
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
      config: this.config,
    }
  }
}

function saveResultMessage(status: EnqueueResult["status"]): string {
  switch (status) {
    case "queued":
      return "Saved for later. It will appear in Mandarin after analysis."
    case "not_connected":
      return "Connect Link Lingo to Mandarin before saving."
    case "paused":
      return "Sentence saving is unavailable right now."
    case "rejected":
      return "That sentence could not be saved."
    case "dropped":
      return "The learning queue is full. Open Mandarin and try again."
    case "error":
      return "Couldn't save that sentence. Try again."
  }
}
