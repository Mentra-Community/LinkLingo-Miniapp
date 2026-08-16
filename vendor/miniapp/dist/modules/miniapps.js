/**
 * @fileoverview MiniappsModule — `session.miniapps`.
 *
 * Discover and control the lifecycle of OTHER miniapps: list, start, stop.
 * SYSTEM-only — every call rejects with NOT_PERMITTED unless the caller is a
 * system app (Mentra AI is the first consumer). The action *capability* layer
 * (invoke / handle) lives on `session.actions`, not here — these three are
 * operations on the app as a whole, not on a declared action.
 */
import { MiniappRequestType } from "../protocol";
export class MiniappsModule {
    constructor(session) {
        this.session = session;
    }
    /**
     * List installed miniapps. Compatible-only by default; pass
     * `{includeIncompatible: true}` to include the rest (each carries a
     * `compatibility` result with the missing hardware). SYSTEM-only.
     */
    async list(opts) {
        const result = await this.session.sendRequest({
            type: MiniappRequestType.MINIAPPS_LIST,
            includeIncompatible: opts?.includeIncompatible ?? false,
        });
        return result ?? [];
    }
    /**
     * Start another miniapp in the **background** — spawns its background JS
     * context without changing the user's phone navigation or foregrounding
     * anything. The app reports as running and can handle actions / drive the
     * glasses immediately; its WebView only mounts if the user later opens it.
     * SYSTEM-only.
     */
    async start(packageName) {
        await this.session.sendRequest({
            type: MiniappRequestType.MINIAPPS_START,
            packageName,
        });
    }
    /** Stop another miniapp. SYSTEM-only. */
    async stop(packageName) {
        await this.session.sendRequest({
            type: MiniappRequestType.MINIAPPS_STOP,
            packageName,
        });
    }
}
//# sourceMappingURL=miniapps.js.map