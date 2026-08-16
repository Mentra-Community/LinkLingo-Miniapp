/**
 * @fileoverview useSafeArea — React hook exposing the host's safe-area insets
 * and the capsule menu rect to miniapp UIs.
 *
 * The host injects these via window.MentraOS before content loads. This hook
 * reads them once at mount — they don't currently change at runtime (the host
 * would have to force a reload to update them, e.g. on orientation change).
 */
import { type MiniappCapsuleMenuRect, type MiniappSafeAreaInsets } from "../globals";
export interface UseSafeAreaResult {
    /** Pixel insets around the WebView content. Apply as padding on your root element. */
    insets: MiniappSafeAreaInsets;
    /**
     * Bounding rect of the host's floating capsule menu (top-right overlay).
     * Null when the host doesn't render one (e.g. older builds). Use this to
     * avoid placing clickable content underneath the menu.
     */
    capsuleMenu: MiniappCapsuleMenuRect | null;
}
export declare function useSafeArea(): UseSafeAreaResult;
//# sourceMappingURL=useSafeArea.d.ts.map