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
import type { RpcReq, RpcRes, RpcRequestOptions } from "../modules/ui";
export interface RpcCallable<TChannels extends object, C extends keyof TChannels & string> {
    (payload: RpcReq<TChannels[C]>, options?: RpcRequestOptions): Promise<RpcRes<TChannels[C]>>;
    /** Abort the current in-flight call (if any). No-op if nothing is pending. */
    abort(): void;
}
/**
 * Returns a stable callable for an RPC channel. The callable auto-aborts
 * on unmount and exposes `.abort()` for cancel-previous patterns.
 *
 *   const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
 *   const suggestions = await autocomplete({query: "..."})
 *   autocomplete.abort()   // cancel the latest in-flight call
 */
export declare function useRpc<TChannels extends object, C extends keyof TChannels & string>(channel: C): RpcCallable<TChannels, C>;
//# sourceMappingURL=useRpc.d.ts.map