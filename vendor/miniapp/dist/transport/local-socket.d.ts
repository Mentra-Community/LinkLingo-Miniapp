/**
 * @fileoverview LocalSocket transport — browser fallback.
 *
 * When the miniapp runs in an external browser (Safari/Chrome, not inside the
 * MentraOS React Native WebView), it connects to a localhost WebSocket that
 * MentraOS exposes via MiniSockets.
 *
 * Default endpoint: ws://127.0.0.1:8765. Override via the `url` option for
 * dev / testing.
 */
import { Transport, TransportDisconnectHandler, TransportMessageHandler } from "./types";
export interface LocalSocketTransportOptions {
    url?: string;
}
export declare class LocalSocketTransport implements Transport {
    private url;
    private ws;
    private messageHandler;
    private disconnectHandler;
    constructor(options?: LocalSocketTransportOptions);
    open(): Promise<void>;
    send(raw: string): void;
    onMessage(handler: TransportMessageHandler): void;
    onDisconnect(handler: TransportDisconnectHandler): void;
    close(): void;
    isOpen(): boolean;
}
//# sourceMappingURL=local-socket.d.ts.map