/**
 * @fileoverview SimpleStorage — phone-local key-value store scoped to
 * (userId, packageName). Mirrors cloud SDK v3's StorageManager surface.
 *
 * All operations round-trip to LocalMiniappRuntime, which reads/writes
 * the phone's storage with a namespaced key format:
 *   mentraos_localstorage_{userId}_{packageName}_{key}
 *
 * Values are plain strings. Callers serialize structured data with
 * JSON.stringify themselves (matching cloud's SimpleStorage shape).
 */
import { MiniappSession } from "../session";
export declare class SimpleStorage {
    private readonly session;
    constructor(session: MiniappSession);
    /** Get a value by key. Resolves to null when the key is unset. */
    get(key: string): Promise<string | null>;
    /** Set a single key/value pair. Overwrites silently. */
    set(key: string, value: string): Promise<void>;
    /** Delete one key. No-op if the key is unset. */
    delete(key: string): Promise<void>;
    /** List every key in this miniapp's namespace. */
    keys(): Promise<string[]>;
    /**
     * @deprecated Renamed to `keys()` for cloud SDK parity. This alias will be
     * removed in a future release.
     */
    list(): Promise<string[]>;
    /** Drop every key in this miniapp's namespace. */
    clear(): Promise<void>;
    /** True iff `key` is set in this miniapp's namespace. */
    has(key: string): Promise<boolean>;
    /**
     * Read every key/value pair in this miniapp's namespace. Useful for
     * hydrating state on bootstrap. Bounded by the underlying namespace
     * size — keep total stored payload small (typical < 1 MB) to avoid
     * stalling the JSContext when this resolves.
     */
    getAll(): Promise<Record<string, string>>;
    /** Write many key/value pairs in one round-trip. */
    setMultiple(values: Record<string, string>): Promise<void>;
    /**
     * Force any pending in-flight writes to disk. No-op today because the
     * host writes through immediately, but reserved so a future debounced
     * backend can honor "flush before I quit" calls without breaking the
     * API.
     */
    flush(): Promise<void>;
}
//# sourceMappingURL=storage.d.ts.map