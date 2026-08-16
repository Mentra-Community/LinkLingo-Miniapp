/**
 * @fileoverview DisplayManager — glasses display layouts.
 *
 * Mirrors cloud SDK v3's DisplayManager naming. Was called `LayoutManager` /
 * `session.layouts` before the v3-alignment round.
 *
 * Wire shape matches the cloud SDK's DisplayRequest:
 *
 *   { type: "DISPLAY",
 *     view: "main" | "dashboard",
 *     layout: { layoutType: "text_wall", text: "..." },
 *     durationMs?: number }
 *
 * The phone's LocalMiniappRuntime forwards this to BluetoothSdk.displayEvent,
 * which reads event.view and event.layout.layoutType.
 */
import { MiniappRequestType } from "../protocol";
export class DisplayManager {
    constructor(session) {
        this.session = session;
    }
    send(layout, options = {}) {
        const payloadLayout = options.breakMode && supportsBreakMode(layout) ? { ...layout, breakMode: options.breakMode } : layout;
        this.session.sendOneShot({
            type: MiniappRequestType.DISPLAY,
            view: options.view ?? "main",
            layout: payloadLayout,
            durationMs: options.durationMs,
        });
    }
    /** Show a single block of text filling the glasses display. */
    showTextWall(text, options = {}) {
        this.send({ layoutType: "text_wall", text }, options);
    }
    /** Two stacked text rows — top and bottom. */
    showDoubleTextWall(topText, bottomText, options = {}) {
        this.send({ layoutType: "double_text_wall", topText, bottomText }, options);
    }
    /** Reference card — title plus body text. */
    showReferenceCard(title, text, options = {}) {
        this.send({ layoutType: "reference_card", title, text }, options);
    }
    /** Dashboard card — two-column layout for sections that appear in the OS dashboard. */
    showDashboardCard(leftText, rightText) {
        this.send({ layoutType: "dashboard_card", leftText, rightText }, { view: "dashboard" });
    }
    /**
     * Show a bitmap. Phone SGC handles conversion to glasses-native format.
     *
     * Optional `x`/`y`/`width`/`height` position and size the bitmap's container.
     * Omit them for default placement
     *
     * @example
     * // 100×100 image pinned to the bottom-right of the 576×288 canvas
     * display.showBitmapView(base64Png, {x: 476, y: 188, width: 100, height: 100})
     */
    showBitmapView(data, options = {}) {
        const { x, y, width, height, ...display } = options;
        this.send({ layoutType: "bitmap_view", data, x, y, width, height }, display);
    }
    /**
     * Show text inside a positioned container (G2 only). Unlike `showTextWall`,
     * which fills the whole view, this places the text at an arbitrary x/y with an
     * optional rounded border — e.g. a label next to a bitmap.
     *
     * @example
     * // Label pinned to the bottom-left of the 576×288 canvas, with a rounded border
     * display.showTextAt("TEST", {x: 0, y: 201, width: 120, height: 87, borderWidth: 2, borderRadius: 6})
     */
    showTextAt(text, options = {}) {
        const { x, y, width, height, borderWidth, borderRadius, ...display } = options;
        this.send({ layoutType: "positioned_text", text, x, y, width, height, borderWidth, borderRadius }, display);
    }
    /** Clear the specified view. */
    clear(view = "main") {
        this.send({ layoutType: "clear_view" }, { view });
    }
}
function supportsBreakMode(layout) {
    return layout.layoutType === "text_wall" || layout.layoutType === "double_text_wall" || layout.layoutType === "reference_card";
}
//# sourceMappingURL=display.js.map