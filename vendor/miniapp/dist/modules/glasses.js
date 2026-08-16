/**
 * @fileoverview GlassesModule — device-state events for the glasses themselves.
 *
 * Reports on the glasses hardware: battery level + charging state, connection
 * status (connected/disconnected, model name). The phone has its own battery
 * + connection events on `session.phone`.
 */
import { MiniappRequestType, MiniappStreamType } from "../protocol";
export class GlassesModule {
    constructor(session) {
        this.session = session;
    }
    onBattery(handler) {
        return this.session._subscribe(MiniappStreamType.GLASSES_BATTERY, handler);
    }
    onConnection(handler) {
        return this.session._subscribe(MiniappStreamType.GLASSES_CONNECTION, handler);
    }
    /**
     * Subscribe to glasses Wi-Fi state. Fires the current state on subscribe and
     * on every change. `connected` is false on glasses without Wi-Fi. Streaming
     * requires Wi-Fi — pair this with {@link requestWifiSetup} to prompt the user.
     */
    onWifi(handler) {
        return this.session._subscribe(MiniappStreamType.GLASSES_WIFI, handler);
    }
    /**
     * Ask the host to open the glasses Wi-Fi setup flow on the phone. Mirrors the
     * cloud SDK's `session.requestWifiSetup(reason)`. `reason` is a user-facing
     * line shown in the setup prompt (e.g. "Streaming needs your glasses on Wi-Fi").
     */
    async requestWifiSetup(reason) {
        await this.session.sendRequest({
            type: MiniappRequestType.REQUEST_WIFI_SETUP,
            reason,
        });
    }
}
//# sourceMappingURL=glasses.js.map