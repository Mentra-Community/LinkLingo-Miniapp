/**
 * @fileoverview useCapsuleHeaderStyle — ready-to-spread React CSS props that
 * vertically align a header row with the host's floating capsule menu.
 *
 * Use this when you want full control over header markup but want the
 * alignment math done for you. If you just want a stock header, use
 * <MiniappHeader> instead.
 *
 * Example:
 *   const style = useCapsuleHeaderStyle()
 *   <header style={style}>
 *     <h1>Hello</h1>
 *   </header>
 */
import type { CSSProperties } from "react";
export interface UseCapsuleHeaderStyleOptions {
    /** Extra left padding beyond the safe area. Default 20px. */
    leftPadding?: number;
    /** Extra space between the header content and the capsule menu. Default 16px. */
    rightGap?: number;
    /** Fallback header height when no capsule menu is present. Default 32px. */
    fallbackHeight?: number;
    /** Fallback top margin when no capsule menu is present. Default 16px. */
    fallbackMarginTop?: number;
}
export declare function useCapsuleHeaderStyle(options?: UseCapsuleHeaderStyleOptions): CSSProperties;
//# sourceMappingURL=useCapsuleHeaderStyle.d.ts.map