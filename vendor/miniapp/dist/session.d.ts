/**
 * @fileoverview MiniappSession — central session object for a local miniapp.
 *
 * Owns the transport, the request/response correlation map, the readiness queue,
 * the PONG auto-reply, the visibility state, and all per-module instances.
 *
 * Lifecycle:
 *   const session = new MiniappSession()
 *   await session.connect()          // sends CONNECT, resolves on CONNECT_ACK
 *   session.display.showTextWall(...)
 *   ...
 *   session.disconnect()
 */
import { MiniappColorScheme } from "./globals";
import { MiniappErrorCode, MiniappResponseType } from "./protocol";
import { CreateTransportOptions } from "./transport/auto";
import { CameraModule } from "./modules/camera";
import { CanvasManager } from "./modules/canvas";
import { AuthModule } from "./modules/auth";
import { CloudModule } from "./modules/cloud";
import { DashboardAPI } from "./modules/dashboard";
import { DisplayManager } from "./modules/display";
import { EventManager, type UnsubscribeFn } from "./modules/events";
import { GlassesModule } from "./modules/glasses";
import { HeadingModule } from "./modules/heading";
import { ImuModule } from "./modules/imu";
import { InputModule } from "./modules/input";
import { LedModule } from "./modules/led";
import { LocationModule } from "./modules/location";
import { MicModule } from "./modules/mic";
import { NavigationModule } from "./modules/navigation";
import { PermissionsModule } from "./modules/permissions";
import { PhoneModule } from "./modules/phone";
import { TranscriptionModule } from "./modules/transcription";
import { TranslationModule } from "./modules/translation";
import { type UIModule } from "./modules/ui";
import { SimpleStorage } from "./modules/storage";
import { SpeakerModule } from "./modules/speaker";
import { StreamModule } from "./modules/stream";
import { SystemModule } from "./modules/system";
import { MiniappsModule } from "./modules/miniapps";
import { ActionsModule } from "./modules/actions";
import { BlobModule } from "./modules/blob";
/** Minimal snapshot of the currently-connected glasses. Phone-provided. */
export interface GlassesCapabilities {
    [key: string]: unknown;
}
export type MiniappVisibility = "foreground" | "background";
export interface MiniappSessionOptions extends CreateTransportOptions {
    /** Override auto-detected packageName. Normally provided via window.MentraOS. */
    packageName?: string;
    /** Override the ready timeout. Default 10s. */
    connectTimeoutMs?: number;
}
export interface ConnectAckPayload {
    type: MiniappResponseType.CONNECT_ACK;
    userId: string;
    packageName: string;
    capabilities: GlassesCapabilities | null;
    visibility?: MiniappVisibility;
    colorScheme?: MiniappColorScheme;
    /**
     * Manifest-declared permission record. Mirrors cloud SDK v3's PermissionRecord:
     * `{location, microphone, camera, notifications, calendar}` — booleans
     * indicating whether the miniapp's manifest declared each. This is
     * declaration-only; OS-grant state is not modeled.
     */
    permissions?: PermissionRecord;
    /** Miniapp-scoped backend auth. Never a Core or runtime token. */
    auth?: MiniappAuthState;
}
export interface MiniappAuthState {
    mentraUserId: string;
    oemId?: string;
    token: string;
    expiresAt: number;
}
export interface AuthUpdatePayload {
    type: MiniappResponseType.AUTH_UPDATE;
    auth?: MiniappAuthState;
}
/**
 * Manifest-declared permission record. v3-aligned: lowercase canonical keys.
 * Booleans indicate whether the miniapp declared each in its manifest.json.
 */
export type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar";
export type PermissionRecord = Record<PermissionType, boolean>;
export declare class NotConnectedError extends Error {
    readonly code = MiniappErrorCode.NOT_CONNECTED;
    constructor(message?: string);
}
export interface MiniappRequestError {
    code: string;
    message: string;
}
type SessionEmitterEvents = {
    ready: () => void;
    error: (error: Error) => void;
    /**
     * Last-chance hook before the transport closes. Fires when the phone
     * sends WILL_DISCONNECT, or when this session calls `disconnect()`
     * locally. Handlers run synchronously and may issue one final
     * `sendOneShot` (e.g. `display.clear()`); async work won't complete
     * before the socket closes.
     */
    beforeDisconnect: (reason: string) => void;
    disconnect: (reason: string) => void;
    visibility: (v: MiniappVisibility) => void;
    capabilities: (cap: GlassesCapabilities | null) => void;
    colorScheme: (scheme: MiniappColorScheme) => void;
    permissions: (perms: PermissionRecord) => void;
    speakerState: (event: import("./modules/speaker").SpeakerStateEvent) => void;
    auth: (auth: MiniappAuthState) => void;
};
export declare class MiniappSession {
    readonly auth: AuthModule;
    readonly canvas: CanvasManager;
    readonly display: DisplayManager;
    /**
     * Internal subscription registry + escape hatch.
     *
     * Domain modules (`session.mic`, `session.input`, etc.) are the canonical
     * surface for typed event subscriptions. `events.subscribe(...)` remains as
     * a forward-compat escape hatch for new event types not yet wrapped on a
     * domain module.
     */
    readonly events: EventManager;
    readonly speaker: SpeakerModule;
    readonly camera: CameraModule;
    readonly cloud: CloudModule;
    readonly dashboard: DashboardAPI;
    readonly glasses: GlassesModule;
    readonly heading: HeadingModule;
    readonly imu: ImuModule;
    readonly input: InputModule;
    readonly led: LedModule;
    readonly location: LocationModule;
    readonly mic: MicModule;
    readonly navigation: NavigationModule;
    readonly permissions: PermissionsModule;
    readonly phone: PhoneModule;
    readonly storage: SimpleStorage;
    /**
     * Phone-local persistent BINARY storage (`session.blob`) — the binary
     * counterpart to `session.storage`. Files on disk, scoped to this miniapp.
     * Writes/reads are chunked so large payloads (e.g. captured audio fed in via
     * `session.mic.onAudioChunk`) never cross the bridge in one message.
     */
    readonly blob: BlobModule;
    readonly stream: StreamModule;
    readonly system: SystemModule;
    readonly transcription: TranscriptionModule;
    readonly translation: TranslationModule;
    /**
     * UI message bus to the bound WebView (when one is open).
     * Background-only API surface; mirrors the WebView's `mentra` global
     * with inverted buffering policy (background drops when no WebView is
     * bound; the WebView buffers until ready).
     */
    readonly ui: UIModule;
    /**
     * Inter-miniapp lifecycle + discovery (list / start / stop). SYSTEM-only —
     * calls reject with NOT_PERMITTED unless this miniapp is a system app.
     */
    readonly miniapps: MiniappsModule;
    /**
     * Inter-miniapp action layer. `invoke` (SYSTEM-only) calls another miniapp's
     * declared action; `handle` (open to all) exposes one of your own.
     */
    readonly actions: ActionsModule;
    /** Phone-declared glasses capabilities. Null until CONNECT_ACK arrives. */
    capabilities: GlassesCapabilities | null;
    userId: string;
    packageName: string;
    visibility: MiniappVisibility;
    /** Host color scheme. Seeded from window.MentraOS, updated via session events. */
    colorScheme: MiniappColorScheme;
    /** True after CONNECT_ACK. Observe with waitForReady() or the "ready" event. */
    ready: boolean;
    private readonly transport;
    private readonly connectTimeoutMs;
    private readonly emitter;
    private authState;
    private readonly authWaiters;
    private authRefreshPromise;
    /**
     * Outbound queue for anything sent before CONNECT_ACK. Flushed in FIFO order
     * once the phone responds with CONNECT_ACK.
     */
    private readonly outboundQueue;
    private readonly pendingRequests;
    private connectPromise;
    private disposed;
    /** Manifest-declared permission cache. Updated on CONNECT_ACK / PERMISSIONS_UPDATE. */
    private _permissions;
    constructor(options?: MiniappSessionOptions);
    /**
     * @internal — synchronous lookup against the cached manifest-declared
     * permission record from CONNECT_ACK / PERMISSIONS_UPDATE. Domain modules
     * use this to expose their `hasPermission` getters without going to the
     * wire. Returns false until CONNECT_ACK arrives.
     *
     * `manifestKey` is the manifest's UPPER_CASE permission name
     * (MICROPHONE, CAMERA, LOCATION, READ_NOTIFICATIONS, etc.). Maps to v3's
     * lowercase canonical keys internally.
     */
    _hasManifestPermission(manifestKey: string): boolean;
    /**
     * @internal — read the current manifest-declared permission record.
     * Powers session.permissions.getAll(). Returns a fresh shallow copy so
     * callers can't mutate internal state.
     */
    _getPermissions(): PermissionRecord;
    /** @internal — current miniapp-scoped backend auth, if the host provided one. */
    _getAuth(): MiniappAuthState | null;
    /**
     * @internal — wait for a scoped miniapp token. Used by session.auth; not part
     * of the public SDK surface because authors should never manage wire events.
     */
    _waitForAuth(minTtlMs: number, timeoutMs?: number): Promise<MiniappAuthState>;
    /**
     * @internal — subscribe to a raw stream type. Domain modules call this; it
     * delegates to the EventManager registry. Underscore prefix signals "not
     * part of the public SDK surface — use session.mic.onAudioChunk /
     * session.transcription.on(...)
     * etc. instead."
     */
    _subscribe(streamType: string, handler: (data: unknown) => void): UnsubscribeFn;
    /**
     * Connect to LocalMiniappRuntime. Idempotent — calling multiple times
     * returns the same Promise.
     */
    connect(): Promise<void>;
    /** Resolves when `ready` becomes true, or rejects if connect failed. */
    waitForReady(): Promise<void>;
    isConnected(): boolean;
    disconnect(): void;
    /** Send a fire-and-forget request that does not need a response. */
    sendOneShot(payload: object): void;
    /**
     * Send a request and get a Promise that resolves with the REQUEST_RESULT payload.
     * Rejects with a MiniappRequestError if the phone returns an error result.
     *
     * `opts.timeoutMs` overrides the default request timeout. Pass `0` to disable
     * it entirely for inherently long-running requests whose duration is unbounded
     * (e.g. audio playback that resolves only when the clip finishes) — those still
     * settle via REQUEST_RESULT or `failAllPending` on disconnect, so they can't
     * leak. Most requests should keep the default ceiling.
     */
    sendRequest<TResult = unknown>(payload: object, opts?: {
        timeoutMs?: number;
    }): Promise<TResult>;
    on<K extends keyof SessionEmitterEvents>(event: K, handler: SessionEmitterEvents[K]): () => void;
    off<K extends keyof SessionEmitterEvents>(event: K, handler: SessionEmitterEvents[K]): void;
    /**
     * Last-chance hook before the transport closes. Fires either when the
     * phone notifies the session of an imminent disconnect (~50ms grace
     * window before the socket is torn down) or when this session's
     * `disconnect()` is called locally. Use it to flush final cleanup
     * messages — e.g. `display.clear()` — synchronously. Async work
     * started here will not complete before the socket closes.
     */
    onBeforeDisconnect(handler: (reason: string) => void): () => void;
    onVisibilityChange(handler: (v: MiniappVisibility) => void): () => void;
    onCapabilitiesChange(handler: (cap: GlassesCapabilities | null) => void): () => void;
    onColorSchemeChange(handler: (scheme: MiniappColorScheme) => void): () => void;
    private enqueueOrSend;
    private flushQueue;
    private handleIncoming;
    private handleTransportDisconnect;
    private failAllPending;
    private authHasTtl;
    private requestAuthRefresh;
    private applyAuth;
    /**
     * Update the cached permission record. Idempotent: emits "permissions"
     * only when the record actually changed. Sanitizes incoming objects to
     * the v3 PermissionType union.
     */
    private applyPermissions;
}
/** @internal — for the permissions module's onUpdate plumbing. */
export declare function _allPermissionTypes(): readonly PermissionType[];
export {};
//# sourceMappingURL=session.d.ts.map