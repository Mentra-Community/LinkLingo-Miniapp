/**
 * @fileoverview LedModule — glasses RGB LED control.
 *
 * API mirrors the cloud SDK's LED module. Colors are named strings
 * (the phone maps them to per-device LED indices). Actions are "on" / "off".
 */
import { MiniappSession } from "../session";
export type LedColor = "red" | "green" | "blue" | "orange" | "white";
export type LedControlResult = {
    type?: "rgb_led_control_response";
    state: "success";
    requestId: string;
};
export interface LedControlOptions {
    color?: LedColor;
    /** LED on duration in ms. */
    ontime?: number;
    /** LED off duration in ms. */
    offtime?: number;
    /** Number of on/off cycles. */
    count?: number;
}
export declare class LedModule {
    private readonly session;
    constructor(session: MiniappSession);
    /** Turn an LED on with the given pattern. Resolves after the glasses acknowledge the command. */
    turnOn(options?: LedControlOptions): Promise<LedControlResult>;
    /** Turn all LEDs off. Resolves after the glasses acknowledge the command. */
    turnOff(): Promise<LedControlResult>;
    /** Blink pattern — repeats `count` times with ontime/offtime. */
    blink(color: LedColor, ontime: number, offtime: number, count: number): Promise<LedControlResult>;
    /** Solid LED for a fixed duration. */
    solid(color: LedColor, duration: number): Promise<LedControlResult>;
}
//# sourceMappingURL=led.d.ts.map