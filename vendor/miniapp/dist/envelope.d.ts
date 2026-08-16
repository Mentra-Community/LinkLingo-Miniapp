/**
 * @fileoverview Bridge envelope format.
 *
 * Every message between @mentra/miniapp and LocalMiniappRuntime is wrapped in
 * this envelope for request/response correlation.
 *
 *   { payload: {...}, requestId?: string }
 */
export interface MiniappEnvelope<P = unknown> {
    payload: P;
    /** Correlates request/response pairs. Set by the sender when it wants a reply. */
    requestId?: string;
}
/** Serialize an envelope for postMessage / WebSocket transport. */
export declare function serializeEnvelope(envelope: MiniappEnvelope): string;
/**
 * Parse a serialized envelope. Returns null for any malformed input — never throws.
 * Transports should pass raw strings in and silently drop nulls.
 */
export declare function parseEnvelope(raw: unknown): MiniappEnvelope | null;
/** Generate a short random requestId. Browser-native (crypto.randomUUID). */
export declare function makeRequestId(): string;
//# sourceMappingURL=envelope.d.ts.map