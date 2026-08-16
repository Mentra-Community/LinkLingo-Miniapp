/**
 * @fileoverview PermissionsModule — manifest-declared permission introspection.
 *
 * Mirrors cloud SDK v3's PermissionsManager surface and semantics:
 *   permissions.has(type)         — synchronous boolean
 *   permissions.getAll()          — full PermissionRecord
 *   permissions.onUpdate(handler) — fires on cache change
 *   permissions.onPermissionError(handler) — typed handler for the existing
 *                                            PERMISSION_NOT_DECLARED error
 *
 * What "permission" means here. Same as v3: this module tracks
 * **manifest-declared** permissions. `permissions.has("microphone") === true`
 * means the miniapp's manifest.json declared MICROPHONE — it does NOT mean
 * the user actually granted the OS permission. To detect OS-grant state,
 * observe whether your subscriptions actually deliver events.
 *
 * OS-level grant state and `request(...)` are deferred to a future round.
 * Their additions will land additively on this same module — `isGranted(...)`
 * / `request(...)` alongside the existing `has(...)` / `getAll(...)` —
 * without renaming today's surface.
 */
import { MiniappErrorCode } from "../protocol";
export class PermissionsModule {
    /** Local handlers for onUpdate. Session emitter handles the fan-out. */
    constructor(session) {
        this.session = session;
    }
    /** True iff the named permission is declared in the miniapp's manifest. */
    has(type) {
        return this.session._getPermissions()[type] === true;
    }
    /** Full record of declared permissions. Fresh shallow copy. */
    getAll() {
        return this.session._getPermissions();
    }
    /**
     * Subscribe to declared-permission updates. Fires when the cached record
     * changes — usually on CONNECT_ACK, or when the phone pushes a
     * PERMISSIONS_UPDATE (e.g. dev miniapp re-scanned with updated manifest).
     *
     * Does NOT fire immediately with the current value — call getAll()
     * separately if you want the seed.
     */
    onUpdate(handler) {
        return this.session.on("permissions", handler);
    }
    /**
     * Subscribe to typed PERMISSION_NOT_DECLARED errors. Sugar over the
     * existing session "error" event, filtered to the permission-error code.
     */
    onPermissionError(handler) {
        return this.session.on("error", (e) => {
            const maybe = e;
            if (maybe?.code === MiniappErrorCode.PERMISSION_NOT_DECLARED) {
                handler({
                    code: String(maybe.code),
                    message: String(maybe.message ?? ""),
                    permission: maybe.permission,
                    subscription: maybe.subscription,
                    operation: maybe.operation,
                });
            }
        });
    }
}
//# sourceMappingURL=permissions.js.map