/**
 * @fileoverview ActionsModule — `session.actions`.
 *
 * The MCP-shaped capability layer, both directions:
 *   - `invoke(pkg, actionId, params)` — call another miniapp's declared action.
 *     SYSTEM-only; headless-wakes the target if it's stopped.
 *   - `handle(actionId, fn)` — expose one of your own actions. Open to all
 *     miniapps. Mirrors `session.ui.handle` (one handler per id, throws on
 *     double-register, errors propagate to the caller).
 *
 * `invoke` ↔ `handle` are the two ends of one wire (keyed by `actionId`), which
 * is why they share this namespace rather than being split across
 * `session.miniapps`.
 */
import { MiniappErrorCode, MiniappRequestType } from "../protocol";
/**
 * How long the SDK holds an inbound ACTION_CALL waiting for its handler to
 * register (a just-woken miniapp registers handlers a beat after CONNECT).
 * If no handler appears in this window the call is failed with
 * NO_ACTION_HANDLER. Mirrors the UI bus's pre-handler buffering.
 */
const HANDLER_WAIT_MS = 5000;
export class ActionsModule {
    constructor(session) {
        this.session = session;
        this.handlers = new Map();
        /** Inbound calls buffered until their handler registers, keyed by actionId. */
        this.buffered = new Map();
    }
    /**
     * Invoke a declared action on another miniapp. Resolves with the handler's
     * return value, rejects with a MiniappRequestError (NOT_PERMITTED,
     * APP_NOT_FOUND, ACTION_NOT_FOUND, WAKE_FAILED, NO_ACTION_HANDLER,
     * ACTION_TIMEOUT, PAYLOAD_TOO_LARGE, or the handler's own error). SYSTEM-only.
     */
    invoke(packageName, actionId, params, opts) {
        return this.session.sendRequest({
            type: MiniappRequestType.ACTION_INVOKE,
            targetPackageName: packageName,
            actionId,
            params: params ?? {},
            ...(opts?.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
        });
    }
    /**
     * Register a handler for one of this miniapp's declared actions. One handler
     * per actionId — throws synchronously on double-register. The returned
     * function unregisters. Declare the action in `miniapp.json` for it to be
     * invokable; an undeclared id still registers but the host never routes to it.
     */
    handle(actionId, handler) {
        if (this.handlers.has(actionId)) {
            throw new Error(`session.actions.handle: a handler is already registered for "${actionId}"`);
        }
        this.handlers.set(actionId, handler);
        // Flush any calls that arrived before this handler registered.
        const waiting = this.buffered.get(actionId);
        if (waiting) {
            this.buffered.delete(actionId);
            for (const call of waiting) {
                clearTimeout(call.timer);
                void this.dispatch(call.callId, actionId, call.params, call.ctx);
            }
        }
        return () => {
            if (this.handlers.get(actionId) === handler)
                this.handlers.delete(actionId);
        };
    }
    /**
     * @internal — called by MiniappSession.handleIncoming on an ACTION_CALL.
     * Routes to the registered handler, or buffers briefly for one to appear.
     */
    _deliver(callId, actionId, params, ctx) {
        if (this.handlers.has(actionId)) {
            void this.dispatch(callId, actionId, params, ctx);
            return;
        }
        // No handler yet — buffer, and fail with NO_ACTION_HANDLER if none registers.
        const timer = setTimeout(() => {
            const arr = this.buffered.get(actionId);
            if (arr) {
                const idx = arr.findIndex((c) => c.callId === callId);
                if (idx >= 0)
                    arr.splice(idx, 1);
                if (arr.length === 0)
                    this.buffered.delete(actionId);
            }
            this.sendResult(callId, false, undefined, {
                code: MiniappErrorCode.NO_ACTION_HANDLER,
                message: `No handler registered for action "${actionId}"`,
            });
        }, HANDLER_WAIT_MS);
        const arr = this.buffered.get(actionId) ?? [];
        arr.push({ callId, params, ctx, timer });
        this.buffered.set(actionId, arr);
    }
    async dispatch(callId, actionId, params, ctx) {
        const handler = this.handlers.get(actionId);
        if (!handler)
            return;
        try {
            const result = await handler(params, ctx);
            this.sendResult(callId, true, result ?? null);
        }
        catch (e) {
            this.sendResult(callId, false, undefined, {
                code: MiniappErrorCode.INTERNAL,
                message: e?.message ?? "action handler threw",
            });
        }
    }
    sendResult(callId, ok, result, error) {
        this.session.sendOneShot({
            type: MiniappRequestType.ACTION_RESULT,
            callId,
            ok,
            ...(ok ? { result } : { error }),
        });
    }
}
//# sourceMappingURL=actions.js.map