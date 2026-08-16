/**
 * @fileoverview PostMessage transport — in-WebView bridge via React Native WebView.
 *
 * The React Native WebView exposes:
 *   - window.ReactNativeWebView.postMessage(string): miniapp → phone
 *   - document "message" events + window "message" events: phone → miniapp
 *
 * react-native-webview sends incoming messages as regular DOM `MessageEvent`s
 * on the `window` object, with `event.data` as the string payload. We listen
 * there.
 *
 * Old MentraOS builds injected a global `window.receiveNativeMessage` function;
 * we also accept that path for compatibility by assigning our handler to it.
 */
import { Transport, TransportDisconnectHandler, TransportMessageHandler } from "./types";
declare global {
    interface Window {
        ReactNativeWebView?: {
            postMessage: (data: string) => void;
        };
        receiveNativeMessage?: (raw: string) => void;
    }
}
export declare class PostMessageTransport implements Transport {
    private messageHandler;
    private disconnectHandler;
    private open_;
    private windowListener;
    open(): Promise<void>;
    send(raw: string): void;
    onMessage(handler: TransportMessageHandler): void;
    onDisconnect(handler: TransportDisconnectHandler): void;
    close(): void;
    isOpen(): boolean;
}
//# sourceMappingURL=postmessage.d.ts.map