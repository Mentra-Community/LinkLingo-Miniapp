import { Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
import { useColorScheme } from "./useColorScheme";
export function MentraProvider({ children, syncColorScheme = true }) {
    const scheme = useColorScheme();
    // Runs during render — before children paint, before effects fire.
    if (syncColorScheme && typeof document !== "undefined") {
        const el = document.documentElement;
        const shouldBeDark = scheme === "dark";
        if (el.classList.contains("dark") !== shouldBeDark) {
            el.classList.toggle("dark", shouldBeDark);
        }
    }
    return _jsx(_Fragment, { children: children });
}
//# sourceMappingURL=MentraProvider.js.map