/**
 * useRpc — React hook around `mentra.request(channel, ...)`.
 *
 * Returns a stable callable plus an `.abort()` method. The internal
 * AbortController is recreated per call and bound to component lifecycle:
 *
 *   - Calling the returned function once: abort() the previous in-flight
 *     call (if any), then issue a fresh request. Useful for per-keystroke
 *     autocomplete — every keystroke aborts the stale request.
 *   - Unmount: all in-flight calls abort.
 *   - Caller-provided `options.signal` is merged with the internal one
 *     via `AbortSignal.any` when available; manual fan-out otherwise.
 */
import { useCallback, useEffect, useRef } from "react";
/** Walk to the global `mentra.request` (typed). */
function getMentraRequest() {
    const m = globalThis.mentra;
    if (!m || typeof m.request !== "function") {
        throw new Error("useRpc: window.mentra.request is not available — is this miniapp running in a UI WebView with the shim injected?");
    }
    return m.request;
}
/** AbortSignal.any polyfill — combine multiple signals into one. */
function mergeSignals(signals) {
    const ctor = AbortSignal;
    if (typeof ctor.any === "function")
        return ctor.any(signals);
    const ctrl = new AbortController();
    const onAbort = (sig) => {
        if (!ctrl.signal.aborted)
            ctrl.abort(sig.reason);
    };
    for (const s of signals) {
        if (s.aborted) {
            onAbort(s);
            break;
        }
        s.addEventListener("abort", () => onAbort(s));
    }
    return ctrl.signal;
}
/**
 * Returns a stable callable for an RPC channel. The callable auto-aborts
 * on unmount and exposes `.abort()` for cancel-previous patterns.
 *
 *   const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
 *   const suggestions = await autocomplete({query: "..."})
 *   autocomplete.abort()   // cancel the latest in-flight call
 */
export function useRpc(channel) {
    // Latest in-flight controller. Replaced on each call.
    const currentRef = useRef(null);
    // Mount controller — aborts every in-flight call on unmount.
    const mountRef = useRef(null);
    if (mountRef.current == null)
        mountRef.current = new AbortController();
    useEffect(() => {
        const mount = mountRef.current;
        return () => {
            mount.abort();
            currentRef.current?.abort();
            currentRef.current = null;
        };
    }, []);
    const callable = useCallback((payload, options) => {
        // Abort any previous call for this hook.
        currentRef.current?.abort();
        const ctrl = new AbortController();
        currentRef.current = ctrl;
        const signals = [ctrl.signal, mountRef.current.signal];
        if (options?.signal)
            signals.push(options.signal);
        const signal = mergeSignals(signals);
        return getMentraRequest()(channel, payload, { signal, timeout: options?.timeout });
    }, [channel]);
    callable.abort = () => {
        currentRef.current?.abort();
        currentRef.current = null;
    };
    return callable;
}
//# sourceMappingURL=useRpc.js.map