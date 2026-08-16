/**
 * @fileoverview TranscriptionModule — top-level transcription API.
 *
 * Mirrors cloud SDK v3's TranscriptionManager:
 *
 *   session.transcription.on(handler)                                // auto-detect
 *   session.transcription.forLanguage("en-US", handler)              // single language
 *   session.transcription.forLanguage(["en-US", "es-ES"], handler)   // multi-language
 *   session.transcription.configure({languageHints, vocabulary, diarization})
 *   session.transcription.stop()                                     // tear down all
 *
 * Hoisted to top-level (vs. nested under `session.mic`) because transcription
 * is a domain in its own right, not a microphone-input event. The `mic`
 * module still exposes lower-level audio chunks + VAD; this module is for
 * "give me text from speech."
 *
 * MICROPHONE permission must be declared in miniapp.json. The phone runtime
 * rejects with PERMISSION_NOT_DECLARED otherwise.
 */
import { MiniappSession } from "../session";
import type { TranscriptionData, UnsubscribeFn } from "./events";
/** Configuration for cloud-side transcription behavior. */
export interface TranscriptionConfig {
    /** ISO 639-1 language hints to improve detection accuracy (e.g. ["en", "ja"]). */
    languageHints?: string[];
    /** Custom vocabulary / boosted terms (e.g. ["MentraOS", "HIPAA"]). */
    vocabulary?: string[];
    /** Enable speaker diarisation. Defaults vary by provider. */
    diarization?: boolean;
}
export declare class TranscriptionModule {
    private readonly session;
    private readonly unsubs;
    private currentConfig;
    constructor(session: MiniappSession);
    /**
     * Subscribe to all transcription events (auto-detect language). The
     * detected language is in `data.language`.
     *
     * Wire-level: subscribes to `transcription:auto`. Today's wildcard fan-out
     * (handlers on `transcription:auto` receive any `transcription:<lang>`
     * event) preserves existing semantics.
     */
    on(handler: (data: TranscriptionData) => void): UnsubscribeFn;
    /**
     * Subscribe to transcription for one or more specific languages. Each call
     * is independent; multiple can be active simultaneously.
     *
     * @param language - BCP-47 tag(s), e.g. `"en-US"` or `["en-US", "es-ES"]`.
     * @param handler  - Called for every event in any of the listed languages.
     */
    forLanguage(language: string | string[], handler: (data: TranscriptionData) => void): UnsubscribeFn;
    /**
     * Apply transcription configuration (language hints, custom vocabulary,
     * diarisation toggle). Sent to the cloud immediately. Cached locally so we
     * could re-send on reconnect (future).
     */
    configure(config: TranscriptionConfig): void;
    /** Tear down every transcription subscription this module owns. */
    stop(): void;
    /** True iff `MICROPHONE` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
    /** @internal — current config, read by tests / future reconnect logic. */
    _getConfig(): TranscriptionConfig | null;
    private track;
}
//# sourceMappingURL=transcription.d.ts.map