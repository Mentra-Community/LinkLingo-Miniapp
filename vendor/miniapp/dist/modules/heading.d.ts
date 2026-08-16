/**
 * @fileoverview HeadingModule — phone compass heading events.
 *
 * Works on both Android and iOS. LOCATION permission must be declared in miniapp.json.
 */
import { MiniappSession } from "../session";
import type { HeadingData, UnsubscribeFn } from "./events";
export declare class HeadingModule {
    private readonly session;
    constructor(session: MiniappSession);
    /** True iff `LOCATION` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
    /** Subscribe to continuous compass heading updates. */
    onUpdate(handler: (data: HeadingData) => void): UnsubscribeFn;
}
//# sourceMappingURL=heading.d.ts.map