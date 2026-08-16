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
export class DispatchTransport {
    constructor() {
        this.messageHandler = null;
        this.disconnectHandler = null;
        this.open_ = false;
    }
    /** True iff `__dispatch` is bound on the current globalThis. */
    static isAvailable() {
        return typeof globalThis.__dispatch === "function";
    }
    async open() {
        if (!DispatchTransport.isAvailable()) {
            throw new Error("DispatchTransport: __dispatch is not installed on globalThis");
        }
        // Wire up the inbound delivery hook so the polyfill's __deliver can
        // route bridge frames here. Installed lazily so multiple transports
        // can share the same global if a test spins up two.
        const g = globalThis;
        g.__mentraDeliverBridgeRaw = (raw) => {
            if (this.messageHandler)
                this.messageHandler(raw);
        };
        this.open_ = true;
    }
    send(raw) {
        if (!this.open_) {
            throw new Error("DispatchTransport: send() before open()");
        }
        const g = globalThis;
        if (typeof g.__dispatch !== "function") {
            // Native bridge gone — surface as a transport-level disconnect so
            // upstream callers don't hang on pending requests.
            this.open_ = false;
            this.disconnectHandler?.("DispatchTransport: __dispatch disappeared");
            return;
        }
        // Wire format: stringify the args array as a single-element array
        // containing the raw envelope. The router unwraps it.
        try {
            g.__dispatch("__bridge", "send", JSON.stringify([raw]));
        }
        catch (e) {
            this.disconnectHandler?.(`DispatchTransport: __dispatch threw: ${String(e)}`);
        }
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    onDisconnect(handler) {
        this.disconnectHandler = handler;
    }
    close() {
        this.open_ = false;
        const g = globalThis;
        if (g.__mentraDeliverBridgeRaw) {
            delete g.__mentraDeliverBridgeRaw;
        }
    }
    isOpen() {
        return this.open_;
    }
}
//# sourceMappingURL=dispatch.js.map