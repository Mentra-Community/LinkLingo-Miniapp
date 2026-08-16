/**
 * session.ui — bus between a background JSContext miniapp and its
 * on-demand UI WebView. Supports two interaction patterns:
 *
 *   1. **Broadcast** (fire-and-forget, either direction)
 *      - background → UI: `session.ui.send(channel, payload)`
 *      - UI → background: `mentra.send(channel, payload)`
 *      - subscribe:        `session.ui.on(channel, cb)` / `mentra.on(channel, cb)`
 *
 *   2. **RPC** (request/response, UI → background only)
 *      - UI side:          `await mentra.request(channel, payload, options?)`
 *      - background side:  `session.ui.handle(channel, (payload, ctx?) => result)`
 *      - single handler per channel; double-register throws synchronously.
 *      - errors thrown in the handler reject the caller's promise.
 *      - cancellation via `options.signal` aborts the handler's `ctx.signal`
 *        and drops the eventual reply.
 *
 * Broadcast vs. RPC is declared at the channel level: wrap a channel's
 * payload type in `Rpc<Req, Res>` in the shared registry to make it RPC.
 * Wrong-API-for-channel is a compile-time error.
 *
 * Buffering:
 *   - `mentra.send` BUFFERS until `mentra.ready()` acks. The WebView is
 *     the short-lived side and shouldn't drop user input.
 *   - `session.ui.send` silently DROPS when no WebView is bound.
 *     Background is the source of truth; UI state shouldn't accumulate.
 *   - Per-channel inbound buffering (up to 32 payloads) covers the
 *     `controller pushed before React attached the listener` race — see
 *     the WebView shim for details.
 *
 * Wire envelopes (internal — not part of the SDK surface):
 *   - `UI_OPEN` — WebView posted `{type:"ready"}`.
 *   - `UI_CLOSE` — host tore down the WebView.
 *   - `UI_MESSAGE` — WebView → background. `requestId` set on RPC calls.
 *   - `UI_SEND` — background → WebView. `requestId` set on RPC replies.
 *   - `UI_CANCEL` — either direction. Carries only `requestId`; aborts
 *     the in-flight handler's signal.
 */
import type { MiniappSession } from "../session";
export type UIChannelHandler<T = unknown> = (payload: T) => void;
export type UIUnsubscribe = () => void;
/**
 * Brand for declaring an RPC channel in the shared Channels registry.
 *
 * Wrap a channel's payload type in `Rpc<Req, Res>` to mark it as
 * request/response. The SDK's `mentra.request` / `session.ui.handle`
 * accept only `Rpc<...>` channels; `mentra.send` / `session.ui.on`
 * accept only non-RPC channels. Using the wrong API for the wrong
 * channel is a compile-time error.
 *
 *   export interface Channels {
 *     "live-transcript": {text: string}                    // broadcast
 *     "compute-route":   Rpc<RouteOpts, RouteResult>       // RPC
 *   }
 */
declare const __rpc_brand: unique symbol;
export type Rpc<Req, Res> = {
    readonly [__rpc_brand]: true;
    readonly req: Req;
    readonly res: Res;
};
/** True if `T` is an `Rpc<...>` channel entry. */
export type IsRpc<T> = T extends Rpc<unknown, unknown> ? true : false;
/** Request payload type of an `Rpc<Req, Res>` entry. */
export type RpcReq<T> = T extends Rpc<infer Req, unknown> ? Req : never;
/** Response payload type of an `Rpc<Req, Res>` entry. */
export type RpcRes<T> = T extends Rpc<unknown, infer Res> ? Res : never;
/** Options accepted by `mentra.request`. */
export interface RpcRequestOptions {
    /** Abort the in-flight call. Sends UI_CANCEL to the handler. */
    signal?: AbortSignal;
    /** Reject with `MentraRpcTimeoutError` after this many ms. No default. */
    timeout?: number;
}
/** Context passed as the optional 2nd arg to an `ui.handle` handler. */
export interface RpcHandlerContext {
    /** Aborts when the UI side cancels the call (or its timeout fires). */
    signal: AbortSignal;
}
/**
 * Error thrown by `mentra.request` when the handler threw or returned an
 * error envelope. Plain `Error` subclass — distinguished by `err.name`.
 * `err.cause` is `{code?: string}` if the handler attached one.
 */
export declare class MentraRpcError extends Error {
    constructor(message: string, options?: {
        cause?: {
            code?: string;
        };
    });
}
/** Thrown by `mentra.request` when its `{timeout}` elapses. */
export declare class MentraRpcTimeoutError extends Error {
    constructor(message?: string);
}
/**
 * Public surface mirrored on `session.ui`. Generic over a `Channels`
 * type-map so miniapps importing the typed `shared/channels.ts` get
 * compile-time enforcement on channel names + payload shapes.
 *
 * Broadcast vs. RPC channels are distinguished at the type level:
 *   - Channel value `Rpc<Req, Res>` → only `handle()` accepts it on
 *     background; only `mentra.request(...)` accepts it on UI.
 *   - Channel value anything else   → only `send()`/`on()` accept it
 *     on both sides.
 *
 * The default `Record<string, unknown>` mapping lets unannotated usage
 * compile — the SDK doesn't impose a registry of its own.
 */
export interface UIModule<TChannels extends object = Record<string, unknown>> {
    /** True iff a WebView is currently bound to this miniapp. */
    isOpen(): boolean;
    /**
     * Subscribe to the "WebView mounted + ready()" lifecycle event. If
     * a WebView is already mounted when subscribe() is called, the
     * handler fires immediately for the current binding.
     */
    onOpen(cb: () => void): UIUnsubscribe;
    /**
     * Subscribe to the "WebView unmounted" lifecycle event. Fires once
     * per close; if no WebView is bound at subscribe time the handler
     * stays armed for the next mount → close cycle.
     */
    onClose(cb: () => void): UIUnsubscribe;
    /**
     * Broadcast a typed message to the bound WebView. Silently drops if
     * no WebView is bound. Compile-error if `C` is an RPC channel.
     */
    send<C extends keyof TChannels & string>(channel: IsRpc<TChannels[C]> extends true ? never : C, payload: TChannels[C]): void;
    /**
     * Subscribe to broadcast messages from the bound WebView. Returns an
     * unsubscribe fn. Compile-error if `C` is an RPC channel — use
     * `handle()` for RPC channels.
     */
    on<C extends keyof TChannels & string>(channel: IsRpc<TChannels[C]> extends true ? never : C, cb: UIChannelHandler<TChannels[C]>): UIUnsubscribe;
    /**
     * Register the single handler for an RPC channel. The UI side calls
     * `mentra.request(channel, payload, options?)`; this handler resolves
     * the call.
     *
     * Throws synchronously if a handler is already registered for the
     * channel. Returns a deregister fn that removes the handler.
     *
     * Compile-error if `C` is a broadcast (non-Rpc) channel.
     */
    handle<C extends keyof TChannels & string>(channel: IsRpc<TChannels[C]> extends true ? C : never, handler: (payload: RpcReq<TChannels[C]>, ctx?: RpcHandlerContext) => Promise<RpcRes<TChannels[C]>> | RpcRes<TChannels[C]>): UIUnsubscribe;
}
export interface RpcErrorEnvelope {
    message: string;
    code?: string;
    stage?: string;
    transport?: string;
}
export declare class UIModuleImpl<TChannels extends object = Record<string, unknown>> implements UIModule<TChannels> {
    private readonly session;
    /** True between UI_OPEN and the matching UI_CLOSE. */
    private bound;
    /** Monotonic outbound seq number. Reset on bind. */
    private nextSeq;
    /** Open-lifecycle handlers — fire on every UI_OPEN. */
    private readonly openHandlers;
    private readonly closeHandlers;
    /** channel → set of subscribers. */
    private readonly channelHandlers;
    /** channel → single registered RPC handler. */
    private readonly rpcHandlers;
    /** requestId → AbortController for in-flight RPC handler invocations. */
    private readonly inflightRpc;
    constructor(session: MiniappSession);
    isOpen: () => boolean;
    onOpen: (cb: () => void) => UIUnsubscribe;
    onClose: (cb: () => void) => UIUnsubscribe;
    send: <C extends keyof TChannels & string>(channel: C, payload: TChannels[C]) => void;
    on: <C extends keyof TChannels & string>(channel: C, cb: UIChannelHandler<TChannels[C]>) => UIUnsubscribe;
    handle: <C extends keyof TChannels & string>(channel: IsRpc<TChannels[C]> extends true ? C : never, handler: (payload: RpcReq<TChannels[C]>, ctx?: RpcHandlerContext) => Promise<RpcRes<TChannels[C]>> | RpcRes<TChannels[C]>) => UIUnsubscribe;
    /** Fire every registered open handler once. Guarded per-handler. */
    private fireOpenHandlers;
    /** @internal — handle UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes from the host. */
    private handleInbound;
    /** @internal — invoke a registered RPC handler and send back the reply. */
    private dispatchRpcCall;
    /** @internal — send a UI_SEND envelope tagged with a requestId. */
    private sendRpcReply;
}
export {};
//# sourceMappingURL=ui.d.ts.map