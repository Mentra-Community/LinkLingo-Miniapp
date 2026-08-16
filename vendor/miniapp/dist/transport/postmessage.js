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
export class PostMessageTransport {
    constructor() {
        this.messageHandler = null;
        this.disconnectHandler = null;
        this.open_ = false;
        this.windowListener = null;
    }
    async open() {
        if (this.open_)
            return;
        if (typeof window === "undefined" || !window.ReactNativeWebView) {
            throw new Error("PostMessageTransport: not running inside a React Native WebView");
        }
        // Listen on window "message" — react-native-webview routes host→webview
        // messages here. Also some builds dispatch on document; hook both.
        this.windowListener = (ev) => {
            const data = ev.data;
            if (typeof data !== "string")
                return;
            this.messageHandler?.(data);
        };
        window.addEventListener("message", this.windowListener);
        if (typeof document !== "undefined") {
            document.addEventListener("message", this.windowListener);
        }
        // Legacy path: some host code calls window.receiveNativeMessage directly.
        window.receiveNativeMessage = (raw) => {
            this.messageHandler?.(raw);
        };
        this.open_ = true;
    }
    send(raw) {
        if (typeof window === "undefined" || !window.ReactNativeWebView) {
            throw new Error("PostMessageTransport: not running inside a React Native WebView");
        }
        window.ReactNativeWebView.postMessage(raw);
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    onDisconnect(handler) {
        this.disconnectHandler = handler;
    }
    close() {
        if (!this.open_)
            return;
        this.open_ = false;
        if (this.windowListener) {
            window.removeEventListener("message", this.windowListener);
            if (typeof document !== "undefined") {
                document.removeEventListener("message", this.windowListener);
            }
            this.windowListener = null;
        }
        if (typeof window !== "undefined" && window.receiveNativeMessage) {
            window.receiveNativeMessage = undefined;
        }
        this.disconnectHandler?.("closed");
    }
    isOpen() {
        return this.open_;
    }
}
//# sourceMappingURL=postmessage.js.map