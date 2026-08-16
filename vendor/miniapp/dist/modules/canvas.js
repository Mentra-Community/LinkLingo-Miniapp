import { MiniappRequestType } from "../protocol";
export var CanvasOperation;
(function (CanvasOperation) {
    CanvasOperation["SHOW_TEXT"] = "show_text";
    CanvasOperation["SHOW_BITMAP"] = "show_bitmap";
    CanvasOperation["CLEAR"] = "clear";
    CanvasOperation["SHOW_PAGE"] = "show_page";
})(CanvasOperation || (CanvasOperation = {}));
export class CanvasManager {
    constructor(session) {
        this.session = session;
    }
    send(operation, options) {
        this.session.sendOneShot({
            type: MiniappRequestType.CANVAS,
            operation,
            options,
        });
    }
    /** Show a single block of text filling the glasses display. */
    showText(text, options = {}) {
        this.send(CanvasOperation.SHOW_TEXT, { text, ...options });
    }
    /**
     * Show a bitmap. Phone SGC handles conversion to glasses-native format.
     * Optional `x`/`y`/`width`/`height` position and size the container; omit for default placement.
     */
    showBitmap(data, options = {}) {
        this.send(CanvasOperation.SHOW_BITMAP, { data, ...options });
    }
    showPage(id, options = {}) {
        this.send(CanvasOperation.SHOW_PAGE, { id, ...options });
    }
    clear(options = {}) {
        this.send(CanvasOperation.CLEAR, options);
    }
}
//# sourceMappingURL=canvas.js.map