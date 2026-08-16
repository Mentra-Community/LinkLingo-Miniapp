import { MiniappSession } from "../session";
export declare enum CanvasOperation {
    SHOW_TEXT = "show_text",
    SHOW_BITMAP = "show_bitmap",
    CLEAR = "clear",
    SHOW_PAGE = "show_page"
}
/** Fields available on every canvas operation. */
export interface BaseOptions {
    page_id?: string;
}
/** Position and size of a view's container on the canvas. */
export interface Box {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}
export interface TextOptions extends Box, BaseOptions {
    borderWidth?: number;
    borderRadius?: number;
}
export type BitmapOptions = Box & BaseOptions;
export type ClearOptions = BaseOptions;
export declare class CanvasManager {
    private readonly session;
    constructor(session: MiniappSession);
    private send;
    /** Show a single block of text filling the glasses display. */
    showText(text: string, options?: TextOptions): void;
    /**
     * Show a bitmap. Phone SGC handles conversion to glasses-native format.
     * Optional `x`/`y`/`width`/`height` position and size the container; omit for default placement.
     */
    showBitmap(data: string, options?: BitmapOptions): void;
    showPage(id: string, options?: BaseOptions): void;
    clear(options?: ClearOptions): void;
}
//# sourceMappingURL=canvas.d.ts.map