/**
 * @fileoverview Dependency-free base64 codec for the miniapp background runtime.
 *
 * The background bundle runs in a per-miniapp JS engine (JavaScriptCore on iOS,
 * QuickJS on Android) where `Buffer`, `btoa`/`atob`, and Node APIs are NOT
 * guaranteed to exist. `session.blob` round-trips binary as base64 strings over
 * the JSON bridge, so it needs an encoder/decoder that works with nothing but
 * the language. This is that — standard RFC 4648 base64, no padding tricks.
 */
/** Coerce a Uint8Array / ArrayBuffer / ArrayBufferView into a Uint8Array view (no copy when possible). */
export declare function toUint8Array(input: Uint8Array | ArrayBuffer | ArrayBufferView): Uint8Array;
/** Encode bytes to a base64 string. */
export declare function bytesToBase64(input: Uint8Array | ArrayBuffer): string;
/** Decode a base64 string to bytes. Ignores whitespace; tolerant of missing padding. */
export declare function base64ToBytes(b64: string): Uint8Array;
//# sourceMappingURL=base64.d.ts.map