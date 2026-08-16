/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Wires to cloud streaming extensions via the __phone__ subscriber path.
 *
 * One entry point: `startStream`. By default it provisions a Mentra-hosted
 * stream and returns playback URLs (managed). Pass `direct` to publish straight
 * to your own ingest URL with no relay.
 */
import { MiniappSession } from "../session";
export interface StreamVideoConfig {
    width?: number;
    height?: number;
    bitrate?: number;
    fps?: number;
}
export interface StreamAudioConfig {
    bitrate?: number;
    sampleRate?: number;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
}
export interface StreamResolvedConfig {
    transport?: "rtmp" | "srt" | "whip";
    video?: {
        width: number;
        height: number;
        captureWidth?: number;
        captureHeight?: number;
        bitrate: number;
        fps: number;
    };
    audio?: {
        bitrate?: number;
        sampleRate?: number;
        echoCancellation?: boolean;
        noiseSuppression?: boolean;
    };
}
/**
 * Restream destination. The full stream key is part of the URL (e.g.
 * `rtmp://yt.com/live/STREAM-KEY`). `name` is a human label that surfaces
 * in dashboards but doesn't affect routing.
 */
export interface RestreamDestination {
    url: string;
    name?: string;
}
export interface StartStreamOptions {
    /**
     * Publish straight to your own ingest URL (rtmp/rtmps/srt/whip). The glasses
     * connect to it directly with no Mentra relay, so no playback URLs come back.
     * Omit this to use the managed relay (the default, best for most apps).
     */
    direct?: string;
    /**
     * Restream destinations the managed relay fans out to (YouTube, Twitch, …).
     * Bare URL strings or `{url, name?}` objects; mix freely. Managed streams
     * only — ignored when `direct` is set.
     */
    destinations?: Array<string | RestreamDestination>;
    video?: StreamVideoConfig;
    audio?: StreamAudioConfig;
    /** Play glasses-side stream start/stop sounds. Defaults to true. */
    sound?: boolean;
    /**
     * Managed ingest protocol, a latency/durability trade. Ignored when `direct`
     * is set.
     *   - "srt" (default): ~10-20s latency via LL-HLS, shareable HLS/DASH URLs,
     *     and automatic recording.
     *   - "whip": sub-second WebRTC playback (use `webrtcUrl`/WHEP), but no
     *     HLS/DASH and no recording.
     */
    ingest?: "srt" | "whip";
    /** Optional Bearer token for direct WHIP Authorization (custom authenticated endpoints). */
    authToken?: string;
}
export interface StreamResult {
    streamId: string;
    status: string;
    resolvedConfig?: StreamResolvedConfig;
    /** Managed streams only: the live-input UID for building hosted-player URLs. */
    liveInputId?: string;
    /** Managed streams only: which playback this stream serves. In "webrtc" mode
     *  `hlsUrl` never serves content. */
    mode?: "hls" | "webrtc";
    /** Managed streams only: HLS playback URL. */
    hlsUrl?: string;
    /** Managed streams only: DASH playback URL. */
    dashUrl?: string;
    /** Managed streams only: WHEP playback URL (present in "webrtc" mode). */
    webrtcUrl?: string;
}
export interface StreamStatus {
    streamId: string;
    status: string;
    errorDetails?: string;
}
export declare class StreamModule {
    private readonly session;
    constructor(session: MiniappSession);
    /**
     * Start a live video stream from the glasses camera.
     *
     * Managed (default) -- Mentra hosts the stream and the result carries
     * `hlsUrl`/`dashUrl`/`webrtcUrl` for playback. Optionally fan out to your own
     * `destinations`.
     *
     * Direct -- pass `direct` with your own ingest URL; the glasses publish to it
     * and no playback URLs are returned.
     */
    startStream(options?: StartStreamOptions): Promise<StreamResult>;
    /** Stop the active stream, or a specific one by `streamId`. */
    stop(streamId?: string): Promise<void>;
}
//# sourceMappingURL=stream.d.ts.map