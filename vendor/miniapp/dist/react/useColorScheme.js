/**
 * @fileoverview useColorScheme — React hook that returns the host's current
 * color scheme.
 *
 * WebView-side hook: reads `window.MentraOS.colorScheme`, injected by the host
 * before the miniapp's content loads. Like `useSafeArea`, this is read once at
 * mount — the host doesn't push color-scheme changes to the WebView at runtime;
 * flipping the phone's theme forces a reload.
 *
 * IMPORTANT: this hook must NOT construct a `MiniappSession`. `MiniappSession`
 * is the *background* (JSContext) API; inside a UI WebView its transport falls
 * back to PostMessage and its `CONNECT` never gets an ACK from the host's UI
 * router, so `session.connect()` times out ("CONNECT_ACK timeout"). UI hooks
 * read host-injected globals instead (see `useSafeArea`).
 */
import { useState } from "react";
import { getMentraOSGlobals } from "../globals";
export function useColorScheme() {
    const [scheme] = useState(() => {
        return getMentraOSGlobals().colorScheme === "dark" ? "dark" : "light";
    });
    return scheme;
}
//# sourceMappingURL=useColorScheme.js.map