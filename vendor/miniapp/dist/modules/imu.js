/**
 * @fileoverview ImuModule — head position + motion events.
 *
 * Glasses' inertial measurement unit. Exposes head-up/down position and a
 * raw accelerometer stream (`onAccel`). Gyroscope / magnetometer / fused
 * orientation are future work — when added they'll surface as a combined IMU
 * event rather than extending this single-sensor accel stream.
 */
import { MiniappRequestType, MiniappStreamType } from "../protocol";
export class ImuModule {
    constructor(session) {
        this.session = session;
    }
    onHeadPosition(handler) {
        return this.session._subscribe(MiniappStreamType.HEAD_POSITION, handler);
    }
    /**
     * Subscribe to raw accelerometer readings (`{x, y, z}` in g) from the
     * glasses IMU. G2 only today; on glasses without an exposed IMU stream the
     * subscription succeeds but no events fire.
     */
    onAccel(handler) {
        return this.session._subscribe(MiniappStreamType.ACCEL_DATA, handler);
    }
    /**
     * Explicitly enable or disable raw accelerometer streaming on the glasses.
     *
     * Subscribing via `onAccel` already auto-enables the sensor and unsubscribing
     * disables it, so most callers don't need this. Use it when you want to drive
     * the IMU directly — e.g. a diagnostic toggle. G2 only today; a no-op on
     * glasses without an exposed IMU stream.
     */
    setEnabled(enabled) {
        return this.session.sendRequest({
            type: MiniappRequestType.IMU_SET_ENABLED,
            enabled,
        });
    }
}
//# sourceMappingURL=imu.js.map