/**
 * @fileoverview SystemModule — OS-level utilities (share, open URL, clipboard, download).
 *
 * These bridge to native phone capabilities via LocalMiniappRuntime.
 */
import { MiniappSession } from "../session";
export interface ShareOptions {
    text?: string;
    url?: string;
    title?: string;
    /** Base64-encoded file data for file sharing. */
    base64?: string;
    /** MIME type when sharing base64 data. */
    mimeType?: string;
    /** Filename when sharing base64 data. */
    filename?: string;
}
export interface ShareResult {
    success: boolean;
    cancelled?: boolean;
}
export interface DownloadOptions {
    /** URL to download from, OR base64 data. */
    url?: string;
    base64?: string;
    filename?: string;
    mimeType?: string;
}
export interface DownloadResult {
    success: boolean;
    cancelled?: boolean;
}
export declare class SystemModule {
    private readonly session;
    constructor(session: MiniappSession);
    /** Open the OS share sheet with the given content. */
    share(options: ShareOptions): Promise<ShareResult>;
    /** Open a URL in the system browser. Blocks dangerous schemes (javascript:, file:). */
    openUrl(url: string): void;
    /** Copy text to the system clipboard. */
    copyToClipboard(text: string): Promise<void>;
    /** Download a file. Opens the OS share sheet so user can choose save location. */
    download(options: DownloadOptions): Promise<DownloadResult>;
}
//# sourceMappingURL=system.d.ts.map