/**
 * @fileoverview DashboardAPI — noop surface in v1.
 *
 * The cloud DashboardManager owns widget rendering in OS-ranked
 * rotation. Keeping the API shape so miniapps compile, but calls are
 * noop + console.warn.
 */
import { MiniappRequestType } from "../protocol";
export class DashboardAPI {
    constructor(session) {
        this.session = session;
        this.warned = false;
    }
    setContent(mode, content) {
        if (!this.warned) {
            console.warn("[@mentra/miniapp] dashboard.setContent() is deferred in v1.");
            this.warned = true;
        }
        // Still forward so the phone can log/ignore consistently.
        this.session.sendOneShot({
            type: MiniappRequestType.DASHBOARD_CONTENT_UPDATE,
            mode,
            content,
        });
    }
}
//# sourceMappingURL=dashboard.js.map