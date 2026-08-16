/**
 * @fileoverview SpeakerModule — phone-side audio output.
 *
 * Mirrors cloud SDK v3's SpeakerManager naming. Audio *input* (transcription,
 * audio chunks, VAD) lives on session.mic — the split is by I/O direction.
 *
 * Imperative surface:
 *   speaker.play({audioUrl})   — play an arbitrary URL via the phone's
 *                                AudioPlaybackService.
 *   speaker.speak(text)        — send a SPEAK request. Phone streams cloud
 *                                TTS when connected and falls back to local
 *                                offline TTS when cloud is unavailable.
 *                                Resolves when playback completes; rejects
 *                                with a TTS_* error code on cloud failure.
 *   speaker.stop()             — stop any audio this miniapp is playing.
 *
 * State observability:
 *   speaker.state              — current SpeakerState (sync getter).
 *   speaker.isPlaying          — true iff state === "playing".
 *   speaker.onStateChange(h)   — fires on every state transition.
 *
 * State machine (per miniapp):
 *   idle ─── speak()/play() ──► loading ──► playing ──► stopped
 *                                  │            │           │
 *                                  └── error ───┴── stop ───┘
 *
 * `error` is transient — fires once with errorCode set, then settles to
 * `stopped` so isPlaying reads false correctly.
 */
import { MiniappSession } from "../session";
import type { UnsubscribeFn } from "./events";
export interface PlayAudioOptions {
    audioUrl: string;
    volume?: number;
    stopOtherAudio?: boolean;
}
export interface SpeakOptions {
    voice_id?: string;
    voice_settings?: Record<string, unknown>;
    volume?: number;
    stopOtherAudio?: boolean;
}
export interface SpeakResult {
    /** True if playback completed; false if playback was interrupted. */
    completed: boolean;
}
export type SpeakerState = "idle" | "loading" | "playing" | "stopped" | "error";
export interface SpeakerStateEvent {
    state: SpeakerState;
    /** When state === "error", the underlying error code (TTS_*, INTERNAL). */
    errorCode?: string;
    errorMessage?: string;
    /** When state === "stopped", how many ms the playback ran (best-effort). */
    durationMs?: number;
}
export declare class SpeakerModule {
    private readonly session;
    private _state;
    private _lastEvent;
    constructor(session: MiniappSession);
    /** Current speaker playback state. */
    get state(): SpeakerState;
    /** True iff state === "playing". */
    get isPlaying(): boolean;
    /** Play a URL. Resolves when playback completes on the phone. */
    play(options: PlayAudioOptions): Promise<void>;
    /**
     * Speak text through the phone. The host streams cloud TTS when connected,
     * then falls back to local offline TTS.
     *
     * Rejects with a MiniappRequestError containing a `code` field on cloud-side
     * TTS failures: `TTS_TEXT_TOO_LONG`, `TTS_INVALID_VOICE`, `TTS_UPSTREAM_ERROR`.
     */
    speak(text: string, options?: SpeakOptions): Promise<SpeakResult>;
    /** Stop any audio this miniapp is currently playing. */
    stop(): void;
    /**
     * Subscribe to speaker state transitions. Fires for every change. Does NOT
     * fire immediately with the current value — call `state` separately if you
     * want the seed.
     */
    onStateChange(handler: (event: SpeakerStateEvent) => void): UnsubscribeFn;
    /** @internal — applied by MiniappSession on inbound SPEAKER_STATE envelope. */
    _applyState(event: SpeakerStateEvent): void;
    /** @internal — for tests. */
    _getLastEvent(): SpeakerStateEvent;
}
//# sourceMappingURL=speaker.d.ts.map