/**
 * @fileoverview useConnected — React hook that returns true while the miniapp's
 * UI WebView is bridged to its background JSContext.
 *
 * WebView-side hook. "Connected" here means the `window.mentra` bridge is open:
 * the shim has fired `mentra.ready()` and the host has bound the WebView so
 * `mentra.send/on/request` flow. Tracked via the shim's `onOpen` / `onClose`.
 * `onOpen` fires its callback immediately if the bridge is already open (see
 * the shim), so late mounts still observe the connected state.
 *
 * IMPORTANT: this hook must NOT construct a `MiniappSession`. That is the
 * *background* (JSContext) API; inside a UI WebView its `CONNECT` never gets an
 * ACK from the host's UI router and `session.connect()` times out
 * ("CONNECT_ACK timeout").
 */
export declare function useConnected(): boolean;
//# sourceMappingURL=useConnected.d.ts.map