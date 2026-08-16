/**
 * @fileoverview DashboardAPI — noop surface in v1.
 *
 * The cloud DashboardManager owns widget rendering in OS-ranked
 * rotation. Keeping the API shape so miniapps compile, but calls are
 * noop + console.warn.
 */
import { MiniappSession } from "../session";
export type DashboardMode = "main" | "expanded" | "always_on";
export declare class DashboardAPI {
    private readonly session;
    private warned;
    constructor(session: MiniappSession);
    setContent(mode: DashboardMode, content: string): void;
}
//# sourceMappingURL=dashboard.d.ts.map