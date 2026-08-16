/**
 * @fileoverview LedModule — glasses RGB LED control.
 *
 * API mirrors the cloud SDK's LED module. Colors are named strings
 * (the phone maps them to per-device LED indices). Actions are "on" / "off".
 */
import { MiniappRequestType } from "../protocol";
export class LedModule {
    constructor(session) {
        this.session = session;
    }
    /** Turn an LED on with the given pattern. Resolves after the glasses acknowledge the command. */
    async turnOn(options = {}) {
        return this.session.sendRequest({
            type: MiniappRequestType.RGB_LED,
            action: "on",
            color: options.color ?? "red",
            ontime: options.ontime ?? 1000,
            offtime: options.offtime ?? 0,
            count: options.count ?? 1,
        });
    }
    /** Turn all LEDs off. Resolves after the glasses acknowledge the command. */
    async turnOff() {
        return this.session.sendRequest({
            type: MiniappRequestType.RGB_LED,
            action: "off",
        });
    }
    /** Blink pattern — repeats `count` times with ontime/offtime. */
    async blink(color, ontime, offtime, count) {
        return this.turnOn({ color, ontime, offtime, count });
    }
    /** Solid LED for a fixed duration. */
    async solid(color, duration) {
        return this.turnOn({ color, ontime: duration, offtime: 0, count: 1 });
    }
}
//# sourceMappingURL=led.js.map