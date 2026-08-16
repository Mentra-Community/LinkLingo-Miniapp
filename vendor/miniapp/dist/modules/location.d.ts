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
import { MiniappSession } from "../session";
import type { LocationData, UnsubscribeFn } from "./events";
export declare class LocationModule {
    private readonly session;
    constructor(session: MiniappSession);
    /** True iff `LOCATION` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
    /** Subscribe to continuous location updates. */
    onUpdate(handler: (data: LocationData) => void): UnsubscribeFn;
    /**
     * Request a single location fix. Resolves with the next available
     * reading from the phone. Useful at app load to seed UI before a
     * continuous stream of updates begins.
     */
    getOnce(): Promise<LocationData>;
}
//# sourceMappingURL=location.d.ts.map