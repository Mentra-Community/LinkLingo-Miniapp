/**
 * @fileoverview PhoneModule — phone device-state events.
 *
 * Mirrors cloud SDK v3's PhoneManager structure. Sub-namespaced by concern:
 *
 *   session.phone.notifications.{on, hasPermission, stop}
 *   session.phone.calendar.{on, hasPermission, stop}
 *   session.phone.onBattery(...)                          // stays flat
 *
 * Imperative phone-OS calls (share, openUrl, copyToClipboard, download) live
 * on `session.system` — different shape (one-shot calls vs. event subs) so
 * we don't conflate them.
 *
 * `phone.notifications.onDismissed` is Android-only. iOS doesn't expose
 * notification-dismiss callbacks to apps (Apple privacy restriction);
 * subscribing on iOS is a no-op even though the API is present.
 */
import { MiniappSession } from "../session";
import type { BatteryData, CalendarEventData, NotificationDismissedData, PhoneNotificationData, UnsubscribeFn } from "./events";
declare class TrackedSubs {
    private readonly unsubs;
    protected track(unsub: UnsubscribeFn): UnsubscribeFn;
    stop(): void;
}
export declare class PhoneNotificationsModule extends TrackedSubs {
    private readonly session;
    constructor(session: MiniappSession);
    on(handler: (data: PhoneNotificationData) => void): UnsubscribeFn;
    /**
     * Subscribe to dismiss events for phone notifications. Fires when the user
     * dismisses (swipes away or clears) a notification.
     *
     * **Android only.** iOS does not expose dismiss callbacks to apps (Apple
     * privacy restriction); subscribing on iOS succeeds but no events ever
     * fire. The matching `notifications.on()` post-event still works on both
     * platforms.
     */
    onDismissed(handler: (data: NotificationDismissedData) => void): UnsubscribeFn;
    /** True iff `READ_NOTIFICATIONS` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
}
export declare class PhoneCalendarModule extends TrackedSubs {
    private readonly session;
    constructor(session: MiniappSession);
    on(handler: (data: CalendarEventData) => void): UnsubscribeFn;
    /** True iff `CALENDAR` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
}
export declare class PhoneModule {
    private readonly session;
    readonly notifications: PhoneNotificationsModule;
    readonly calendar: PhoneCalendarModule;
    constructor(session: MiniappSession);
    /**
     * Phone battery events. Stays flat (not sub-namespaced) — single event,
     * no extra surface.
     */
    onBattery(handler: (data: BatteryData) => void): UnsubscribeFn;
}
export {};
//# sourceMappingURL=phone.d.ts.map