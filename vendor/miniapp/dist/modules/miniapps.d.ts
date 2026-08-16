/**
 * @fileoverview MiniappsModule — `session.miniapps`.
 *
 * Discover and control the lifecycle of OTHER miniapps: list, start, stop.
 * SYSTEM-only — every call rejects with NOT_PERMITTED unless the caller is a
 * system app (Mentra AI is the first consumer). The action *capability* layer
 * (invoke / handle) lives on `session.actions`, not here — these three are
 * operations on the app as a whole, not on a declared action.
 */
import { MiniappSession } from "../session";
/** A declared action surfaced by {@link MiniappsModule.list}. */
export interface MiniappActionInfo {
    id: string;
    description: string;
    /**
     * JSON-Schema input descriptor (the MCP-compatible subset). Maps verbatim
     * to an MCP tool `inputSchema`. Undefined for actions that take no params.
     */
    parameters?: Record<string, unknown>;
}
/**
 * Hardware compatibility for a listed miniapp. Structurally mirrors the host's
 * `CompatibilityResult` so the runtime can pass it straight through.
 */
export interface MiniappCompatibility {
    isCompatible: boolean;
    missingRequired: Array<{
        type: string;
        level?: string;
    }>;
    missingOptional: Array<{
        type: string;
        level?: string;
    }>;
    warnings: string[];
}
/** One installed miniapp, as surfaced to a system caller. */
export interface MiniappInfo {
    packageName: string;
    name: string;
    description?: string;
    version: string;
    running: boolean;
    compatibility: MiniappCompatibility;
    /** Declared actions (empty if the miniapp declares none). */
    actions: MiniappActionInfo[];
}
export interface ListMiniappsOptions {
    /** Include incompatible miniapps too (default false — compatible-only). */
    includeIncompatible?: boolean;
}
export declare class MiniappsModule {
    private readonly session;
    constructor(session: MiniappSession);
    /**
     * List installed miniapps. Compatible-only by default; pass
     * `{includeIncompatible: true}` to include the rest (each carries a
     * `compatibility` result with the missing hardware). SYSTEM-only.
     */
    list(opts?: ListMiniappsOptions): Promise<MiniappInfo[]>;
    /**
     * Start another miniapp in the **background** — spawns its background JS
     * context without changing the user's phone navigation or foregrounding
     * anything. The app reports as running and can handle actions / drive the
     * glasses immediately; its WebView only mounts if the user later opens it.
     * SYSTEM-only.
     */
    start(packageName: string): Promise<void>;
    /** Stop another miniapp. SYSTEM-only. */
    stop(packageName: string): Promise<void>;
}
//# sourceMappingURL=miniapps.d.ts.map