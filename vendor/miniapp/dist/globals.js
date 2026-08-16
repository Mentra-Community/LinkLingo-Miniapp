/**
 * @fileoverview Shape of window.MentraOS, injected by the host MentraOS app
 * before the miniapp's content loads. Miniapp authors generally won't read
 * this directly — use the typed React hooks (useSafeArea, etc.) instead.
 */
/** Reads window.MentraOS safely — returns an empty object if not set. */
export function getMentraOSGlobals() {
    if (typeof window === "undefined")
        return {};
    return window.MentraOS ?? {};
}
//# sourceMappingURL=globals.js.map