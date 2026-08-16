/**
 * @fileoverview DispatchTransport — Transport implementation that rides
 * the native `__dispatch(iface, method, argsJson)` bridge exposed by the
 * MentraJS runtime (per-miniapp JSContext on iOS-JSC, Zipline/QuickJS
 * context on Android).
 *
 * The existing `MiniappSession` (session.ts) is transport-agnostic — it
 * serialises envelopes into JSON strings and hands them to Transport.send().
 * The native side has historically been on the other end of a
 * `window.ReactNativeWebView.postMessage(...)` shim (PostMessageTransport)
 * inside a WebView. In the new architecture, background JS runs in a
 * JSContext that has no WebView — so the wire is `__dispatch` instead.
 *
 * What this transport does:
 *   - send(raw) — calls __dispatch("__bridge", "send", [raw]). The host
 *     side `MentraJSRouter` consumes the raw string verbatim, same shape
 *     as PostMessageTransport's wire payload.
 *   - The polyfill bundle (`startup.ts`) wires __deliver({kind:'bridge',raw})
 *     back into this transport's message handler so the host can push
 *     unsolicited events (mic_pcm, transcription, button events, etc.)
 *     into the SDK.
 *   - open()/close() are no-ops — the JSContext is alive as long as the
 *     host has the runtime spawned; nothing to handshake here.
 *
 * On Android Zipline `__dispatch` is suspending under the hood; on
 * iOS-JSC it's a synchronous Swift block. Both shapes are JSON-string in,
 * JSON-string out, so the JS-side surface is identical.
 */
import { Transport, TransportDisconnectHandler, TransportMessageHandler } from "./types";
export declare class DispatchTransport implements Transport {
    private messageHandler;
    private disconnectHandler;
    private open_;
    /** True iff `__dispatch` is bound on the current globalThis. */
    static isAvailable(): boolean;
    open(): Promise<void>;
    send(raw: string): void;
    onMessage(handler: TransportMessageHandler): void;
    onDisconnect(handler: TransportDisconnectHandler): void;
    close(): void;
    isOpen(): boolean;
}
//# sourceMappingURL=dispatch.d.ts.map