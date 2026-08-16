/**
 * @fileoverview useSafeArea — React hook exposing the host's safe-area insets
 * and the capsule menu rect to miniapp UIs.
 *
 * The host injects these via window.MentraOS before content loads. This hook
 * reads them once at mount — they don't currently change at runtime (the host
 * would have to force a reload to update them, e.g. on orientation change).
 */
import { useState } from "react";
import { getMentraOSGlobals, } from "../globals";
const EMPTY_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
export function useSafeArea() {
    const [result] = useState(() => {
        const globals = getMentraOSGlobals();
        return {
            insets: globals.safeAreaInsets ?? EMPTY_INSETS,
            capsuleMenu: globals.capsuleMenu ?? null,
        };
    });
    return result;
}
//# sourceMappingURL=useSafeArea.js.map