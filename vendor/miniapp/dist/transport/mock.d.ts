/**
 * @fileoverview MockTransport — browser-tab fallback so the SDK doesn't hang.
 *
 * Activates when:
 *   - `window.ReactNativeWebView` is undefined (not in MentraOS WebView), AND
 *   - The first LocalSocketTransport connection attempt fails fast, OR
 *   - The author opts in via `?mentra=mock` query param / `localStorage.MENTRA_MOCK = "1"`.
 *
 * Behaviors:
 *   - On `open()`: synthesize a CONNECT_ACK envelope so `session.connect()` resolves.
 *   - On `send(envelope)`: parse, log to console with `[mock-transport]` prefix,
 *     auto-reply with synthetic results for any request that needs one.
 *   - Does NOT emit any glasses events. Subscribing succeeds silently.
 *
 * This is the Stage-1 stopgap from `agents/miniapp-quick-fixes-spec.md` #6.
 * The full simulator (event injection, glasses-display preview, hardware bridge)
 * is Stage 2 — see `agents/miniapp-browser-testing-simulator-spec.md`.
 */
import type { Transport, TransportDisconnectHandler, TransportMessageHandler } from "./types";
/**
 * Returns true if the current environment requested the mock transport
 * explicitly. Checks `?mentra=mock` query param and `localStorage.MENTRA_MOCK`.
 */
export declare function isMockExplicitlyRequested(): boolean;
export interface MockTransportOptions {
    /** Override the synthetic userId. Default "mock-user". */
    userId?: string;
    /** Override the synthetic miniapp auth token. Default "mock-miniapp-token". */
    authToken?: string;
    /** Override the synthetic packageName when window.MentraOS isn't set. */
    packageName?: string;
    /** Suppress the [mock-transport] console logs. Default false. */
    silent?: boolean;
}
export declare class MockTransport implements Transport {
    private messageHandler;
    private disconnectHandler;
    private open_;
    private readonly userId;
    private readonly authToken;
    private readonly packageName;
    private readonly silent;
    constructor(options?: MockTransportOptions);
    open(): Promise<void>;
    send(raw: string): void;
    onMessage(handler: TransportMessageHandler): void;
    onDisconnect(handler: TransportDisconnectHandler): void;
    close(): void;
    isOpen(): boolean;
    private deliverConnectAck;
    private deliverSyntheticResult;
    private log;
}
//# sourceMappingURL=mock.d.ts.map