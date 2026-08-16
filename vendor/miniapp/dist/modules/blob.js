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
import { MiniappRequestType } from "../protocol";
import { base64ToBytes, bytesToBase64, toUint8Array } from "./base64";
/** Raw bytes per chunked write. ~1 MB raw → ~1.34 MB base64, under the watchdog. */
export const BLOB_WRITE_CHUNK_BYTES = 1024 * 1024;
const BLOB_WRITE_CHUNK_B64 = Math.floor(BLOB_WRITE_CHUNK_BYTES / 3) * 4;
/** Max bytes `bytes()` will buffer before throwing — read large blobs as a stream. */
export const BLOB_READ_ALL_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Streaming writer (`fs.createWriteStream`-like). Call `write`/`writeBase64` as
 * many times as you like (each is auto-split into bridge-safe chunks), then
 * `close()` to publish, or `abort()` to discard the partial blob.
 */
export class BlobWriter {
    constructor(session, key) {
        this.session = session;
        this.key = key;
        this.settled = false;
    }
    /** Append raw bytes. Auto-chunked. */
    async write(chunk) {
        this.assertOpen();
        const bytes = toUint8Array(chunk);
        for (let off = 0; off < bytes.length; off += BLOB_WRITE_CHUNK_BYTES) {
            await this.send(bytesToBase64(bytes.subarray(off, off + BLOB_WRITE_CHUNK_BYTES)));
        }
    }
    /** Append already-base64-encoded bytes (e.g. straight from `mic.onAudioChunk`). */
    async writeBase64(b64) {
        this.assertOpen();
        // Slice on 4-char boundaries so each chunk is whole base64 groups.
        for (let off = 0; off < b64.length; off += BLOB_WRITE_CHUNK_B64) {
            await this.send(b64.slice(off, off + BLOB_WRITE_CHUNK_B64));
        }
    }
    /**
     * Overwrite bytes at a fixed offset within the not-yet-closed blob (a seek
     * write). Must stay within already-written bytes; does not grow the blob.
     * Advanced — used e.g. to patch a container header on finalize.
     */
    async writeAt(offset, chunk) {
        this.assertOpen();
        await this.session.sendRequest({
            type: MiniappRequestType.BLOB_WRITE,
            key: this.key,
            offset,
            base64: bytesToBase64(toUint8Array(chunk)),
        });
    }
    /** Finalize and return the blob's metadata. Optional `meta` merges into the record. */
    async close(meta) {
        this.assertOpen();
        this.settled = true;
        return this.session.sendRequest({ type: MiniappRequestType.BLOB_COMMIT, key: this.key, meta });
    }
    /** Discard the partial blob. Idempotent. */
    async abort() {
        if (this.settled)
            return;
        this.settled = true;
        await this.session.sendRequest({ type: MiniappRequestType.BLOB_ABORT, key: this.key });
    }
    assertOpen() {
        if (this.settled)
            throw new Error("BlobWriter is already closed/aborted");
    }
    send(base64) {
        return this.session.sendRequest({
            type: MiniappRequestType.BLOB_WRITE,
            key: this.key,
            base64,
        });
    }
}
/** Streaming reader (`fs.createReadStream`-like). */
export class BlobReader {
    constructor(session, handle, meta) {
        this.session = session;
        this.handle = handle;
        this.meta = meta;
        this.closed = false;
    }
    /** Read up to `maxBytes` (default one chunk). `done` is true at end of file. */
    async read(maxBytes = BLOB_WRITE_CHUNK_BYTES) {
        if (this.closed)
            throw new Error("BlobReader is closed");
        const res = await this.session.sendRequest({
            type: MiniappRequestType.BLOB_READ,
            handle: this.handle,
            maxBytes,
        });
        return { bytes: base64ToBytes(res?.base64 ?? ""), done: !!res?.done };
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.session.sendRequest({ type: MiniappRequestType.BLOB_CLOSE_READ, handle: this.handle });
    }
}
export class BlobModule {
    constructor(session) {
        this.session = session;
    }
    // ── write ────────────────────────────────────────────────────────────────
    /** Store bytes under `key`. `data` may be a Uint8Array/ArrayBuffer or a base64 string. */
    async set(key, data, opts = {}) {
        const writer = await this.createWriteStream(key, opts);
        try {
            if (typeof data === "string")
                await writer.writeBase64(data);
            else
                await writer.write(data);
            return await writer.close();
        }
        catch (err) {
            await writer.abort().catch(() => { });
            throw err;
        }
    }
    /**
     * Download `url` straight into a blob under `key`, host-side. The bytes never
     * cross the bridge (like the web Cache API's `cache.add`). `opts.headers` lets
     * you pass auth. Resolves to the stored blob's metadata.
     */
    setFromUrl(key, url, opts = {}) {
        return this.session.sendRequest({
            type: MiniappRequestType.BLOB_SET_FROM_URL,
            key,
            url,
            mimeType: opts.mimeType,
            name: opts.name,
            headers: opts.headers,
            meta: opts.meta,
        });
    }
    /**
     * Open the OS file picker and store the chosen file as a blob, host-side.
     * Resolves to the blob's metadata, or `null` if the user cancelled.
     */
    importFile(opts = {}) {
        return this.session.sendRequest({
            type: MiniappRequestType.BLOB_IMPORT,
            key: opts.key,
            mimeType: opts.mimeType,
            meta: opts.meta,
        });
    }
    /** Open a streaming writer for `key` (for large/streamed payloads). */
    async createWriteStream(key, opts = {}) {
        const res = await this.session.sendRequest({
            type: MiniappRequestType.BLOB_CREATE,
            key,
            mimeType: opts.mimeType,
            name: opts.name,
            meta: opts.meta,
        });
        return new BlobWriter(this.session, res.key);
    }
    // ── read ─────────────────────────────────────────────────────────────────
    /** Metadata (incl. the `file://` uri) for `key`, or null if absent. */
    get(key) {
        return this.session.sendRequest({ type: MiniappRequestType.BLOB_GET, key });
    }
    /** Alias of `get` — the file-stat verb. */
    stat(key) {
        return this.get(key);
    }
    /** True iff a blob is stored under `key`. */
    async has(key) {
        return (await this.get(key)) !== null;
    }
    /** Every key this miniapp has stored, newest first. */
    async keys() {
        return (await this.list()).map((m) => m.key);
    }
    /** Every blob this miniapp owns, newest first. */
    async list() {
        const res = await this.session.sendRequest({ type: MiniappRequestType.BLOB_LIST });
        return res?.blobs ?? [];
    }
    /** Open a streaming reader. Prefer `get(key).uri` when you just need to play/share it. */
    async createReadStream(key) {
        const res = await this.session.sendRequest({
            type: MiniappRequestType.BLOB_OPEN_READ,
            key,
        });
        return new BlobReader(this.session, res.handle, res.meta);
    }
    /** Read a whole blob into memory as bytes, or null if absent. Throws past the cap — stream big ones. */
    async bytes(key) {
        let reader;
        try {
            reader = await this.createReadStream(key);
        }
        catch {
            return null;
        }
        const parts = [];
        let total = 0;
        try {
            for (;;) {
                const { bytes, done } = await reader.read();
                if (bytes.length) {
                    total += bytes.length;
                    if (total > BLOB_READ_ALL_MAX_BYTES) {
                        throw new Error(`Blob "${key}" exceeds the in-memory read cap — stream it with createReadStream()`);
                    }
                    parts.push(bytes);
                }
                if (done)
                    break;
            }
        }
        finally {
            await reader.close().catch(() => { });
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }
    // ── manage ───────────────────────────────────────────────────────────────
    /** Per-app usage + the quota ceiling, in bytes. */
    usage() {
        return this.session.sendRequest({
            type: MiniappRequestType.BLOB_USAGE,
        });
    }
    /** Delete the blob under `key`. No-op if absent. */
    async delete(key) {
        await this.session.sendRequest({ type: MiniappRequestType.BLOB_DELETE, key });
    }
    /** Delete every blob this miniapp owns. */
    async clear() {
        await this.session.sendRequest({ type: MiniappRequestType.BLOB_CLEAR });
    }
    /** Share the blob via the OS share sheet (host shares from disk — no bytes cross the bridge). */
    async share(key) {
        const res = await this.session.sendRequest({
            type: MiniappRequestType.BLOB_SHARE,
            key,
        });
        return res ?? { success: false };
    }
}
//# sourceMappingURL=blob.js.map