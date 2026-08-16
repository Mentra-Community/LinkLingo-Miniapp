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
import { MiniappSession } from "../session";
/** Context handed to an action handler. `callerPackageName` is host-stamped. */
export interface ActionContext {
    /** The package that invoked this action (trustworthy — set by the host). */
    callerPackageName: string;
}
export type ActionHandler = (params: Record<string, unknown>, ctx: ActionContext) => unknown | Promise<unknown>;
export interface InvokeOptions {
    /** Overall timeout in ms (default 30s, max 120s — host-enforced). */
    timeoutMs?: number;
}
export declare class ActionsModule {
    private readonly session;
    private readonly handlers;
    /** Inbound calls buffered until their handler registers, keyed by actionId. */
    private readonly buffered;
    constructor(session: MiniappSession);
    /**
     * Invoke a declared action on another miniapp. Resolves with the handler's
     * return value, rejects with a MiniappRequestError (NOT_PERMITTED,
     * APP_NOT_FOUND, ACTION_NOT_FOUND, WAKE_FAILED, NO_ACTION_HANDLER,
     * ACTION_TIMEOUT, PAYLOAD_TOO_LARGE, or the handler's own error). SYSTEM-only.
     */
    invoke<TResult = unknown>(packageName: string, actionId: string, params?: Record<string, unknown>, opts?: InvokeOptions): Promise<TResult>;
    /**
     * Register a handler for one of this miniapp's declared actions. One handler
     * per actionId — throws synchronously on double-register. The returned
     * function unregisters. Declare the action in `miniapp.json` for it to be
     * invokable; an undeclared id still registers but the host never routes to it.
     */
    handle(actionId: string, handler: ActionHandler): () => void;
    /**
     * @internal — called by MiniappSession.handleIncoming on an ACTION_CALL.
     * Routes to the registered handler, or buffers briefly for one to appear.
     */
    _deliver(callId: string, actionId: string, params: Record<string, unknown>, ctx: ActionContext): void;
    private dispatch;
    private sendResult;
}
//# sourceMappingURL=actions.d.ts.map