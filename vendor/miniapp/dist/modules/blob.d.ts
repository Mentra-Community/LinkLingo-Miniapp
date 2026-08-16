/**
 * @fileoverview BlobModule — phone-local persistent BINARY storage, keyed and
 * scoped to (userId, packageName). The binary sibling of `session.storage`:
 * where storage holds small strings, blob holds arbitrary bytes (PDFs, EPUBs,
 * audio, video, model files, caches) as files on the phone.
 *
 * It deliberately mirrors `session.storage`'s shape — `set` / `get` / `delete` /
 * `keys` / `has` / `clear` — so it's instantly familiar, plus the things files
 * (and not strings) need:
 *   - `setFromUrl(key, url)` — the host downloads a URL straight to disk
 *     (like the web Cache API's `cache.add`, iOS `URLSession` download task, or
 *     Android `DownloadManager`). Bytes never cross the bridge.
 *   - `importFile()` — opens the OS file picker and stores the chosen file.
 *     Bytes never cross the bridge.
 *   - `share(key)` — hands the file to the OS share sheet.
 *   - `createWriteStream` / `createReadStream` — for streaming huge payloads
 *     (named like Node's `fs.createWriteStream`).
 *
 * BACKGROUND-ONLY. Binary doesn't belong in the WebView. A blob's `uri` is a
 * `file://` path in the app's private storage — fine for `session.speaker.play`,
 * `blob.share`, or another host capability, but a WebView generally can't load
 * it directly (route rendering through a host viewer for now).
 *
 * Transfer model: the bridge moves JSON strings through a per-miniapp JS engine
 * (JSC/QuickJS) with a watchdog, so in-JS writes/reads are CHUNKED (≤ ~1 MB raw
 * per call). Prefer `setFromUrl` / `importFile` when you can — they keep the
 * bytes entirely host-side.
 */
import { MiniappSession } from "../session";
/** Metadata for one stored blob. `uri` is a `file://` path. */
export interface BlobMeta {
    /** The key it's stored under (caller-chosen). */
    key: string;
    /** Optional display/file name (e.g. the original filename for an import). */
    name?: string;
    /** MIME type, e.g. "application/pdf". */
    mimeType: string;
    /** Size on disk in bytes. */
    bytes: number;
    /** Epoch ms first written. */
    createdAt: number;
    /** Epoch ms last written. */
    updatedAt: number;
    /** Content md5 (lowercase hex), computed host-side (skipped for very large blobs). */
    md5?: string;
    /** `file://` URI. Feed to `session.speaker.play`, `blob.share`, etc. */
    uri: string;
    /** App-defined metadata persisted with the blob. */
    meta?: Record<string, string | number | boolean>;
}
export interface BlobSetOptions {
    /** Default "application/octet-stream". */
    mimeType?: string;
    name?: string;
    meta?: Record<string, string | number | boolean>;
}
export interface BlobSetFromUrlOptions extends BlobSetOptions {
    /** Request headers (e.g. an Authorization token) for the download. */
    headers?: Record<string, string>;
}
export interface BlobImportOptions {
    /** Key to store under. Default: a generated key. */
    key?: string;
    /** Restrict the picker to a MIME type, e.g. "application/pdf". */
    mimeType?: string;
    meta?: Record<string, string | number | boolean>;
}
/** Raw bytes per chunked write. ~1 MB raw → ~1.34 MB base64, under the watchdog. */
export declare const BLOB_WRITE_CHUNK_BYTES: number;
/** Max bytes `bytes()` will buffer before throwing — read large blobs as a stream. */
export declare const BLOB_READ_ALL_MAX_BYTES: number;
/**
 * Streaming writer (`fs.createWriteStream`-like). Call `write`/`writeBase64` as
 * many times as you like (each is auto-split into bridge-safe chunks), then
 * `close()` to publish, or `abort()` to discard the partial blob.
 */
export declare class BlobWriter {
    private readonly session;
    readonly key: string;
    private settled;
    constructor(session: MiniappSession, key: string);
    /** Append raw bytes. Auto-chunked. */
    write(chunk: Uint8Array | ArrayBuffer): Promise<void>;
    /** Append already-base64-encoded bytes (e.g. straight from `mic.onAudioChunk`). */
    writeBase64(b64: string): Promise<void>;
    /**
     * Overwrite bytes at a fixed offset within the not-yet-closed blob (a seek
     * write). Must stay within already-written bytes; does not grow the blob.
     * Advanced — used e.g. to patch a container header on finalize.
     */
    writeAt(offset: number, chunk: Uint8Array | ArrayBuffer): Promise<void>;
    /** Finalize and return the blob's metadata. Optional `meta` merges into the record. */
    close(meta?: Record<string, string | number | boolean>): Promise<BlobMeta>;
    /** Discard the partial blob. Idempotent. */
    abort(): Promise<void>;
    private assertOpen;
    private send;
}
/** Streaming reader (`fs.createReadStream`-like). */
export declare class BlobReader {
    private readonly session;
    readonly handle: string;
    readonly meta: BlobMeta;
    private closed;
    constructor(session: MiniappSession, handle: string, meta: BlobMeta);
    /** Read up to `maxBytes` (default one chunk). `done` is true at end of file. */
    read(maxBytes?: number): Promise<{
        bytes: Uint8Array;
        done: boolean;
    }>;
    close(): Promise<void>;
}
export declare class BlobModule {
    private readonly session;
    constructor(session: MiniappSession);
    /** Store bytes under `key`. `data` may be a Uint8Array/ArrayBuffer or a base64 string. */
    set(key: string, data: Uint8Array | ArrayBuffer | string, opts?: BlobSetOptions): Promise<BlobMeta>;
    /**
     * Download `url` straight into a blob under `key`, host-side. The bytes never
     * cross the bridge (like the web Cache API's `cache.add`). `opts.headers` lets
     * you pass auth. Resolves to the stored blob's metadata.
     */
    setFromUrl(key: string, url: string, opts?: BlobSetFromUrlOptions): Promise<BlobMeta>;
    /**
     * Open the OS file picker and store the chosen file as a blob, host-side.
     * Resolves to the blob's metadata, or `null` if the user cancelled.
     */
    importFile(opts?: BlobImportOptions): Promise<BlobMeta | null>;
    /** Open a streaming writer for `key` (for large/streamed payloads). */
    createWriteStream(key: string, opts?: BlobSetOptions): Promise<BlobWriter>;
    /** Metadata (incl. the `file://` uri) for `key`, or null if absent. */
    get(key: string): Promise<BlobMeta | null>;
    /** Alias of `get` — the file-stat verb. */
    stat(key: string): Promise<BlobMeta | null>;
    /** True iff a blob is stored under `key`. */
    has(key: string): Promise<boolean>;
    /** Every key this miniapp has stored, newest first. */
    keys(): Promise<string[]>;
    /** Every blob this miniapp owns, newest first. */
    list(): Promise<BlobMeta[]>;
    /** Open a streaming reader. Prefer `get(key).uri` when you just need to play/share it. */
    createReadStream(key: string): Promise<BlobReader>;
    /** Read a whole blob into memory as bytes, or null if absent. Throws past the cap — stream big ones. */
    bytes(key: string): Promise<Uint8Array | null>;
    /** Per-app usage + the quota ceiling, in bytes. */
    usage(): Promise<{
        bytes: number;
        count: number;
        quotaBytes: number;
    }>;
    /** Delete the blob under `key`. No-op if absent. */
    delete(key: string): Promise<void>;
    /** Delete every blob this miniapp owns. */
    clear(): Promise<void>;
    /** Share the blob via the OS share sheet (host shares from disk — no bytes cross the bridge). */
    share(key: string): Promise<{
        success: boolean;
        cancelled?: boolean;
    }>;
}
//# sourceMappingURL=blob.d.ts.map