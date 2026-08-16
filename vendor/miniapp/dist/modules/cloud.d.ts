/**
 * @fileoverview CloudModule — local miniapp view of the phone-owned cloud client.
 *
 * Miniapps do not own or configure the cloud connection. The phone owns one
 * cloud-client instance and pushes status snapshots here so miniapps can render
 * honest UX such as online/offline captions indicators.
 */
import { MiniappSession } from "../session";
import type { UnsubscribeFn } from "./events";
export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected";
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none";
export interface CloudClientStatus {
    status: CloudClientConnectionStatus;
    audioTransport: CloudClientAudioTransport;
}
export declare const CLOUD_STATUS_STREAM = "_cloud_status";
export declare class CloudModule {
    private readonly session;
    private readonly emitter;
    private current;
    constructor(session: MiniappSession);
    /** Latest status snapshot pushed by the phone runtime. */
    get status(): CloudClientStatus;
    /** True when the phone's cloud-client runtime handshake is complete. */
    get connected(): boolean;
    /** Method alias for callers who prefer function-style state reads. */
    isConnected(): boolean;
    /**
     * Subscribe to cloud-client status updates. The current value is delivered
     * immediately so UI code can hydrate without waiting for the next transition.
     */
    onStatusChanged(handler: (status: CloudClientStatus) => void): UnsubscribeFn;
}
//# sourceMappingURL=cloud.d.ts.map