/**
 * @fileoverview CloudModule — local miniapp view of the phone-owned cloud client.
 *
 * Miniapps do not own or configure the cloud connection. The phone owns one
 * cloud-client instance and pushes status snapshots here so miniapps can render
 * honest UX such as online/offline captions indicators.
 */
import { EventEmitter } from "eventemitter3";
export const CLOUD_STATUS_STREAM = "_cloud_status";
const DEFAULT_STATUS = {
    status: "disconnected",
    audioTransport: "none",
};
function normalizeCloudStatus(data) {
    if (!data || typeof data !== "object")
        return null;
    const raw = data;
    const status = raw.status;
    const audioTransport = raw.audioTransport;
    if (status !== "connected" && status !== "connecting" && status !== "reconnecting" && status !== "disconnected") {
        return null;
    }
    if (audioTransport !== "udp" &&
        audioTransport !== "ws" &&
        audioTransport !== "offline" &&
        audioTransport !== "none") {
        return null;
    }
    return { status, audioTransport };
}
export class CloudModule {
    constructor(session) {
        this.session = session;
        this.emitter = new EventEmitter();
        this.current = { ...DEFAULT_STATUS };
        this.session._subscribe(CLOUD_STATUS_STREAM, (data) => {
            const next = normalizeCloudStatus(data);
            if (!next)
                return;
            if (next.status === this.current.status && next.audioTransport === this.current.audioTransport)
                return;
            this.current = next;
            this.emitter.emit("status", { ...this.current });
        });
    }
    /** Latest status snapshot pushed by the phone runtime. */
    get status() {
        return { ...this.current };
    }
    /** True when the phone's cloud-client runtime handshake is complete. */
    get connected() {
        return this.current.status === "connected";
    }
    /** Method alias for callers who prefer function-style state reads. */
    isConnected() {
        return this.connected;
    }
    /**
     * Subscribe to cloud-client status updates. The current value is delivered
     * immediately so UI code can hydrate without waiting for the next transition.
     */
    onStatusChanged(handler) {
        handler({ ...this.current });
        this.emitter.on("status", handler);
        return () => {
            this.emitter.off("status", handler);
        };
    }
}
//# sourceMappingURL=cloud.js.map