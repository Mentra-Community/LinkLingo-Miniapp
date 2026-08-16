/**
 * @fileoverview HeadingModule — phone compass heading events.
 *
 * Works on both Android and iOS. LOCATION permission must be declared in miniapp.json.
 */
import { MiniappStreamType } from "../protocol";
export class HeadingModule {
    constructor(session) {
        this.session = session;
    }
    /** True iff `LOCATION` is declared in the miniapp's manifest. */
    get hasPermission() {
        return this.session._hasManifestPermission("LOCATION");
    }
    /** Subscribe to continuous compass heading updates. */
    onUpdate(handler) {
        return this.session._subscribe(MiniappStreamType.HEADING_UPDATE, handler);
    }
}
//# sourceMappingURL=heading.js.map