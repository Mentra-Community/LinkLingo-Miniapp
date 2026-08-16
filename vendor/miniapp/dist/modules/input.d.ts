/**
 * @fileoverview InputModule — physical control events on the glasses.
 *
 * Combines button + touch surfaces. Future input modes (gesture, voice
 * command, eye tracking) will extend this module rather than spawning new
 * top-level modules.
 *
 * Touch overloads:
 *
 *   session.input.onTouch(handler)
 *   session.input.onTouch("single_tap", handler)
 *   session.input.onTouch(["swipe_up", "swipe_down"], handler)
 *
 * Per-gesture filtering rides on `touch_event:<gesture>` stream variants
 * the phone runtime fans out alongside the bare `touch_event` stream.
 */
import { MiniappSession } from "../session";
import type { ButtonPressData, TouchData, UnsubscribeFn } from "./events";
export declare class InputModule {
    private readonly session;
    constructor(session: MiniappSession);
    onButtonPress(handler: (data: ButtonPressData) => void): UnsubscribeFn;
    /**
     * Subscribe to touch events.
     *
     *   onTouch(handler)                — all touch events
     *   onTouch("single_tap", handler)  — only single taps
     *   onTouch(["a","b"], handler)     — multiple gestures, single subscription
     */
    onTouch(handler: (data: TouchData) => void): UnsubscribeFn;
    onTouch(gesture: string, handler: (data: TouchData) => void): UnsubscribeFn;
    onTouch(gestures: string[], handler: (data: TouchData) => void): UnsubscribeFn;
}
//# sourceMappingURL=input.d.ts.map