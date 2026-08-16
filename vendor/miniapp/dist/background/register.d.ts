/**
 * registerMiniapp — entry hook for the background JSContext.
 *
 * The MentraJS host loads the polyfill (which installs __dispatch /
 * __deliver / timers / fetch / etc.), then evaluates the miniapp's
 * background bundle. After both scripts have evaluated successfully,
 * the host delivers a single `{kind: "init", sessionId}` envelope.
 * The polyfill turns that into a call to `__mentraInitCallback(sessionId)`.
 *
 * This module wires that callback to:
 *   1. Construct a `MiniappSession` (DispatchTransport picks itself
 *      automatically because `__dispatch` is on globalThis).
 *   2. Call the user-supplied handler synchronously so subscriptions
 *      are registered before any host events fan out.
 *   3. Call `session.connect()` so the host receives CONNECT and the
 *      first CONNECT_ACK populates `userId`, `capabilities`, etc.
 *
 * The handler runs once per spawn. If the host kills + respawns the
 * JSContext (crash recovery, dev reload), the polyfill + bundle are
 * re-evaluated and the handler fires again with a fresh session.
 */
import { MiniappSession, type MiniappSessionOptions } from "../session";
export type MiniappInitHandler = (session: MiniappSession) => void | Promise<void>;
/**
 * Register the miniapp's startup handler. Call once at the top level of
 * `src/background/index.ts`. Top-level side effects are fine, but the
 * vast majority of setup should live inside the handler so it can run
 * with a connected session.
 *
 * @example
 *   registerMiniapp((session) => {
 *     session.transcription.on((tx) => {
 *       session.display.showTextWall(tx.text)
 *     })
 *   })
 */
export declare function registerMiniapp(handler: MiniappInitHandler, options?: MiniappSessionOptions): void;
//# sourceMappingURL=register.d.ts.map