/**
 * @fileoverview LocationModule — phone location events.
 *
 * Exposes both a continuous `onUpdate` subscription and a one-shot
 * `getOnce()` poll over `MiniappRequestType.LOCATION_POLL`.
 *
 * LOCATION permission must be declared in miniapp.json for either path to
 * succeed; the phone runtime rejects with PERMISSION_NOT_DECLARED
 * otherwise.
 */
import { MiniappRequestType, MiniappStreamType } from "../protocol";
export class LocationModule {
    constructor(session) {
        this.session = session;
    }
    /** True iff `LOCATION` is declared in the miniapp's manifest. */
    get hasPermission() {
        return this.session._hasManifestPermission("LOCATION");
    }
    /** Subscribe to continuous location updates. */
    onUpdate(handler) {
        return this.session._subscribe(MiniappStreamType.LOCATION_UPDATE, handler);
    }
    /**
     * Request a single location fix. Resolves with the next available
     * reading from the phone. Useful at app load to seed UI before a
     * continuous stream of updates begins.
     */
    getOnce() {
        return this.session.sendRequest({
            type: MiniappRequestType.LOCATION_POLL,
        });
    }
}
//# sourceMappingURL=location.js.map