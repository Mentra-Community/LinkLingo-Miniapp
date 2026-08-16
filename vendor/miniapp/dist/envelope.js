/**
 * @fileoverview Bridge envelope format.
 *
 * Every message between @mentra/miniapp and LocalMiniappRuntime is wrapped in
 * this envelope for request/response correlation.
 *
 *   { payload: {...}, requestId?: string }
 */
/** Serialize an envelope for postMessage / WebSocket transport. */
export function serializeEnvelope(envelope) {
    return JSON.stringify(envelope);
}
/**
 * Parse a serialized envelope. Returns null for any malformed input — never throws.
 * Transports should pass raw strings in and silently drop nulls.
 */
export function parseEnvelope(raw) {
    if (typeof raw !== "string")
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null)
        return null;
    const obj = parsed;
    if (typeof obj.payload !== "object" || obj.payload === null)
        return null;
    if (obj.requestId !== undefined && typeof obj.requestId !== "string")
        return null;
    return {
        payload: obj.payload,
        requestId: obj.requestId,
    };
}
/** Generate a short random requestId. Browser-native (crypto.randomUUID). */
export function makeRequestId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    // Fallback for older engines: timestamp + random suffix. Not cryptographically secure.
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
//# sourceMappingURL=envelope.js.map