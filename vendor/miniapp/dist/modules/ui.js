/**
 * Error thrown by `mentra.request` when the handler threw or returned an
 * error envelope. Plain `Error` subclass — distinguished by `err.name`.
 * `err.cause` is `{code?: string}` if the handler attached one.
 */
export class MentraRpcError extends Error {
    constructor(message, options) {
        super(message);
        this.name = "MentraRpcError";
        // Assign `cause` directly: the package's tsconfig targets ES2020 lib
        // where `Error`'s ctor is typed as 1-arity (no `ErrorOptions`).
        // Modern JS engines still allow setting `cause` as a plain property.
        if (options?.cause !== undefined) {
            ;
            this.cause = options.cause;
        }
    }
}
/** Thrown by `mentra.request` when its `{timeout}` elapses. */
export class MentraRpcTimeoutError extends Error {
    constructor(message = "RPC timed out") {
        super(message);
        this.name = "MentraRpcTimeoutError";
    }
}
function rpcErrorFromUnknown(e) {
    if (e instanceof Error) {
        // `cause` is ES2022; this package's lib targets ES2020 where Error
        // has no `cause` field. Read it via a structural cast. Diagnostic fields
        // (code/stage/transport) may live as own props (PhotoError-style) or on
        // the cause — own props win.
        const own = e;
        const cause = own.cause;
        return compactEnvelope({
            message: e.message,
            code: own.code ?? cause?.code,
            stage: own.stage,
            transport: own.transport,
        });
    }
    if (e && typeof e === "object") {
        // Hosts reject RPCs with plain structured objects ({code, message, stage,
        // transport}); stringifying them produced the infamous "[object Object]".
        const o = e;
        return compactEnvelope({
            message: typeof o.message === "string" ? o.message : JSON.stringify(e),
            code: typeof o.code === "string" ? o.code : undefined,
            stage: typeof o.stage === "string" ? o.stage : undefined,
            transport: typeof o.transport === "string" ? o.transport : undefined,
        });
    }
    return { message: String(e) };
}
function compactEnvelope(env) {
    const out = { message: env.message };
    if (env.code)
        out.code = env.code;
    if (env.stage)
        out.stage = env.stage;
    if (env.transport)
        out.transport = env.transport;
    return out;
}
export class UIModuleImpl {
    constructor(session) {
        this.session = session;
        /** True between UI_OPEN and the matching UI_CLOSE. */
        this.bound = false;
        /** Monotonic outbound seq number. Reset on bind. */
        this.nextSeq = 1;
        /** Open-lifecycle handlers — fire on every UI_OPEN. */
        this.openHandlers = new Set();
        this.closeHandlers = new Set();
        /** channel → set of subscribers. */
        this.channelHandlers = new Map();
        /** channel → single registered RPC handler. */
        this.rpcHandlers = new Map();
        /** requestId → AbortController for in-flight RPC handler invocations. */
        this.inflightRpc = new Map();
        // Arrow-property bindings make every public method safe to destructure
        // (`const {send} = session.ui`) or pass as a bare callback — a plain
        // method loses `this` and crashes on `this.bound`.
        this.isOpen = () => {
            return this.bound;
        };
        this.onOpen = (cb) => {
            this.openHandlers.add(cb);
            if (this.bound) {
                // Late subscriber — fire once for the current binding so callers
                // that wire onOpen *after* the WebView mounted don't miss it.
                // Gate on session readiness for the same reason handleInbound does:
                // a late onOpen must still observe populated capabilities, not the
                // pre-CONNECT_ACK null snapshot. If not yet ready, the "ready"
                // listener registered in handleInbound's UI_OPEN branch will fan
                // out to every openHandler (this one included), so we don't wire a
                // second listener here.
                if (this.session.ready) {
                    try {
                        cb();
                    }
                    catch (e) {
                        // eslint-disable-next-line no-console
                        console.warn("session.ui.onOpen late-fire threw:", e);
                    }
                }
            }
            return () => {
                this.openHandlers.delete(cb);
            };
        };
        this.onClose = (cb) => {
            this.closeHandlers.add(cb);
            return () => {
                this.closeHandlers.delete(cb);
            };
        };
        this.send = (channel, payload) => {
            if (!this.bound) {
                // Per spec: drop silently when no WebView is bound. Background
                // is the source of truth — the WebView re-fetches state on next
                // open via session.ui.onOpen.
                return;
            }
            const seq = this.nextSeq++;
            const envelope = { type: "UI_SEND", channel, payload, seq };
            this.session.sendOneShot(envelope);
        };
        this.on = (channel, cb) => {
            let set = this.channelHandlers.get(channel);
            if (!set) {
                set = new Set();
                this.channelHandlers.set(channel, set);
            }
            set.add(cb);
            return () => {
                set.delete(cb);
            };
        };
        this.handle = (channel, handler) => {
            const key = channel;
            if (this.rpcHandlers.has(key)) {
                throw new Error(`session.ui.handle: a handler is already registered for "${key}"`);
            }
            this.rpcHandlers.set(key, handler);
            return () => {
                this.rpcHandlers.delete(key);
            };
        };
        // The session forwards UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes via
        // its internal stream subscriber surface. The UIModule registers
        // once via session._subscribe to receive them. The "_ui" stream
        // name is internal — not exposed in the public stream list — so
        // the host router knows to route lifecycle frames here without
        // bumping any existing stream type.
        this.session._subscribe("_ui", (env) => this.handleInbound(env));
    }
    /** Fire every registered open handler once. Guarded per-handler. */
    fireOpenHandlers() {
        for (const h of this.openHandlers) {
            try {
                h();
            }
            catch (e) {
                // eslint-disable-next-line no-console
                console.warn("session.ui.onOpen handler threw", e);
            }
        }
    }
    /** @internal — handle UI_OPEN / UI_CLOSE / UI_MESSAGE envelopes from the host. */
    handleInbound(env) {
        if (env.type === "UI_OPEN") {
            this.bound = true;
            this.nextSeq = 1;
            // onOpen handlers almost always read session.capabilities /
            // session.ready to hydrate the fresh WebView. The WebView's
            // `mentra.ready()` (which produces this UI_OPEN) races the
            // background session's CONNECT_ACK — on a fast bridge UI_OPEN can
            // arrive first, leaving capabilities null and the UI rendering a
            // "no glasses" snapshot that never self-corrects. Gate the open
            // fan-out on session readiness so handlers always observe a
            // populated session. The WebView is marked bound immediately
            // (send/isOpen work, inbound stays buffered) — only the open
            // callbacks wait.
            if (this.session.ready) {
                this.fireOpenHandlers();
            }
            else {
                const off = this.session.on("ready", () => {
                    off();
                    // If the WebView closed during the connect window, don't fire
                    // stale open handlers — a later UI_OPEN will re-trigger them.
                    if (this.bound)
                        this.fireOpenHandlers();
                });
            }
            return;
        }
        if (env.type === "UI_CLOSE") {
            this.bound = false;
            for (const h of this.closeHandlers) {
                try {
                    h();
                }
                catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn("session.ui.onClose handler threw", e);
                }
            }
            return;
        }
        if (env.type === "UI_MESSAGE") {
            // RPC call: requestId set → dispatch to handle() handler.
            if (typeof env.requestId === "string") {
                this.dispatchRpcCall(env.channel, env.payload, env.requestId);
                return;
            }
            // Broadcast: fan out to on() subscribers.
            const set = this.channelHandlers.get(env.channel);
            if (!set || set.size === 0)
                return;
            for (const h of set) {
                try {
                    h(env.payload);
                }
                catch (e) {
                    // eslint-disable-next-line no-console
                    console.warn(`session.ui.on(${env.channel}) threw`, e);
                }
            }
            return;
        }
        if (env.type === "UI_CANCEL") {
            const ctrl = this.inflightRpc.get(env.requestId);
            if (ctrl) {
                try {
                    ctrl.abort();
                }
                catch {
                    /* ignore */
                }
            }
            return;
        }
    }
    /** @internal — invoke a registered RPC handler and send back the reply. */
    dispatchRpcCall(channel, payload, requestId) {
        const handler = this.rpcHandlers.get(channel);
        if (!handler) {
            // No handler registered. Reply with a structured error so the
            // UI's request promise rejects with a useful message.
            this.sendRpcReply(channel, requestId, {
                ok: false,
                error: { message: `no handler registered for "${channel}"` },
            });
            return;
        }
        const ctrl = new AbortController();
        this.inflightRpc.set(requestId, ctrl);
        const ctx = { signal: ctrl.signal };
        const finish = (envelope) => {
            this.inflightRpc.delete(requestId);
            // If the controller already aborted (UI cancelled), drop the
            // reply — the UI side has already removed its listener.
            if (ctrl.signal.aborted)
                return;
            this.sendRpcReply(channel, requestId, envelope);
        };
        let result;
        try {
            result = handler(payload, ctx);
        }
        catch (e) {
            finish({ ok: false, error: rpcErrorFromUnknown(e) });
            return;
        }
        if (result && typeof result.then === "function") {
            ;
            result.then((v) => finish({ ok: true, result: v }), (e) => finish({ ok: false, error: rpcErrorFromUnknown(e) }));
        }
        else {
            finish({ ok: true, result });
        }
    }
    /** @internal — send a UI_SEND envelope tagged with a requestId. */
    sendRpcReply(channel, requestId, payload) {
        if (!this.bound)
            return;
        const seq = this.nextSeq++;
        const envelope = { type: "UI_SEND", channel, payload, seq, requestId };
        this.session.sendOneShot(envelope);
    }
}
//# sourceMappingURL=ui.js.map