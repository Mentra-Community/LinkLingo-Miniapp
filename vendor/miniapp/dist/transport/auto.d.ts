/**
 * @fileoverview Auto-detect the right Transport based on environment.
 */
import { Transport } from "./types";
export interface CreateTransportOptions {
    /** Force a specific transport. Skip auto-detection. */
    transport?: Transport;
    /** For LocalSocketTransport fallback — override the ws URL. */
    localSocketUrl?: string;
}
/**
 * Return a Transport appropriate for the current environment.
 *
 * Detection order (first match wins):
 *
 * 1. **DispatchTransport** — when running in a per-miniapp JSContext
 *    (no DOM, but `__dispatch` is installed on `globalThis` by the
 *    MentraJS runtime). This is the production path.
 * 2. **PostMessageTransport** — inside a MentraOS WebView
 *    (`window.ReactNativeWebView` defined). This is the existing UI
 *    layer path and the only transport miniapp UI bundles need.
 * 3. **MockTransport** — explicit opt-in via `?mentra=mock` or
 *    `localStorage.MENTRA_MOCK=1`. Useful for Storybook / unit tests.
 * 4. **LocalSocketWithMockFallback** — external browser, races a
 *    `ws://127.0.0.1` LocalSocketTransport open against a 500ms timeout
 *    and falls back to MockTransport so the page doesn't hang.
 * 5. **MockTransport** — no `WebSocket` at all (some embedded contexts,
 *    jsdom without a polyfill). Keeps the SDK from throwing.
 *
 * DispatchTransport is checked FIRST because the JSContext doesn't have
 * a `window` global, so it'd otherwise fall through to LocalSocket and
 * race a non-existent dev WebSocket — annoying and confusing in logs.
 */
export declare function createTransport(options?: CreateTransportOptions): Transport;
//# sourceMappingURL=auto.d.ts.map