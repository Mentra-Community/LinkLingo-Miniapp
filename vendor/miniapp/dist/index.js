/**
 * @mentra/miniapp — SDK for building MentraOS local miniapps.
 *
 * Public entry point. Consumers do:
 *
 *   import {MiniappSession} from "@mentra/miniapp"            // background JSContext
 *   import {useColorScheme} from "@mentra/miniapp/react"      // UI WebView hooks
 *   import {MiniappRequestType} from "@mentra/miniapp/protocol"
 */
import { installDevReloadListenerIfDevMode } from "./dev-reload";
// Auto-install the dev-reload listener on module import so authors get live
// reload for free in dev builds. No-op in production (gated on
// window.MentraOS.miniappDeveloperMode).
installDevReloadListenerIfDevMode();
export { MiniappSession, NotConnectedError } from "./session";
export { makeRequestId, parseEnvelope, serializeEnvelope } from "./envelope";
export { getMentraOSGlobals } from "./globals";
export { MiniappErrorCode, MiniappRequestType, MiniappResponseType, MiniappStreamType } from "./protocol";
export { CLOUD_STATUS_STREAM } from "./modules/cloud";
// Hardware requirement types — re-exported from @mentra/types so miniapp
// authors can type their miniapp.json manifest without pulling in the types
// package directly. Keep explicit exports (enums as value, interfaces as
// type) per @mentra/types' Bun-compat convention.
export { HardwareType, HardwareRequirementLevel } from "@mentra/types";
// Transports — exported for advanced uses (forced transport injection, tests)
export { createTransport } from "./transport/auto";
export { PostMessageTransport } from "./transport/postmessage";
export { LocalSocketTransport } from "./transport/local-socket";
export { MockTransport, isMockExplicitlyRequested } from "./transport/mock";
export { CanvasOperation } from "./modules/canvas";
//# sourceMappingURL=index.js.map