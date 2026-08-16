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
import { useSafeArea } from "./useSafeArea";
export function useCapsuleHeaderStyle(options = {}) {
    const { leftPadding = 20, rightGap = 16, fallbackHeight = 32, fallbackMarginTop = 16 } = options;
    const { insets, capsuleMenu } = useSafeArea();
    const height = capsuleMenu?.height ?? fallbackHeight;
    const center = capsuleMenu
        ? capsuleMenu.top + capsuleMenu.height / 2 - insets.top
        : fallbackMarginTop + height / 2;
    const marginTop = Math.max(0, center - height / 2);
    const paddingRight = capsuleMenu ? capsuleMenu.width + rightGap : leftPadding;
    return {
        display: "flex",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "space-between",
        paddingLeft: leftPadding,
        paddingRight,
        marginTop,
        height,
    };
}
//# sourceMappingURL=useCapsuleHeaderStyle.js.map