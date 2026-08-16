import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCapsuleHeaderStyle } from "./useCapsuleHeaderStyle";
function BackChevron({ onBack }) {
    return (_jsx("button", { type: "button", onClick: onBack, "aria-label": "Back", style: {
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            marginLeft: -8,
            padding: 0,
            border: "none",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            borderRadius: 8,
        }, children: _jsx("svg", { width: "22", height: "22", viewBox: "0 0 24 24", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "M15 18l-6-6 6-6", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }) }) }));
}
export function MiniappHeader({ title, left, onBack, right, className, style, bottomSpacer = true, ...styleOptions }) {
    const computedStyle = useCapsuleHeaderStyle(styleOptions);
    const resolvedLeft = left ?? (onBack ? _jsx(BackChevron, { onBack: onBack }) : null);
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: className, style: { ...computedStyle, ...style }, children: [_jsxs("div", { style: { display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }, children: [resolvedLeft, typeof title === "string" ? (_jsx("h1", { style: {
                                    fontSize: 18,
                                    fontWeight: 600,
                                    lineHeight: 1,
                                    margin: 0,
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                }, children: title })) : (title)] }), right ? (_jsx("div", { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }, children: right })) : null] }), bottomSpacer ? _jsx("div", { style: { height: 8, flexShrink: 0 } }) : null] }));
}
//# sourceMappingURL=MiniappHeader.js.map