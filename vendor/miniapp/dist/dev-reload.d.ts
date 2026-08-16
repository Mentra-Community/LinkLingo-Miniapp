/**
 * @fileoverview SDK-side dev-reload listener — auto-installed when the host
 * indicates we're running in a dev miniapp.
 *
 * Companion to the phone-side console-tap shim (which is injected by the
 * MentraOS app, not by the SDK). The SDK installs this listener on import so
 * authors get live reload without any opt-in code.
 *
 * Mechanism:
 *   - Phone-side `DevServerBridge` receives `{type: "reload"}` from the dev
 *     server's WebSocket.
 *   - Phone-side `MiniappHost` then injects a `MessageEvent` into the WebView
 *     with payload `{type: "miniapp_dev_reload"}`.
 *   - This listener catches that MessageEvent and calls `location.reload()`.
 *
 * Gated on `window.MentraOS.miniappDeveloperMode === true` so production
 * miniapps never set up the listener. In production WebViews the host won't
 * inject the message anyway, but belt-and-suspenders.
 */
export declare function installDevReloadListenerIfDevMode(): void;
//# sourceMappingURL=dev-reload.d.ts.map