/**
 * @fileoverview SystemModule — OS-level utilities (share, open URL, clipboard, download).
 *
 * These bridge to native phone capabilities via LocalMiniappRuntime.
 */
import { MiniappRequestType } from "../protocol";
export class SystemModule {
    constructor(session) {
        this.session = session;
    }
    /** Open the OS share sheet with the given content. */
    async share(options) {
        const result = await this.session.sendRequest({
            type: MiniappRequestType.SHARE,
            ...options,
        });
        return result ?? { success: false };
    }
    /** Open a URL in the system browser. Blocks dangerous schemes (javascript:, file:). */
    openUrl(url) {
        this.session.sendOneShot({
            type: MiniappRequestType.OPEN_URL,
            url,
        });
    }
    /** Copy text to the system clipboard. */
    async copyToClipboard(text) {
        await this.session.sendRequest({
            type: MiniappRequestType.COPY_CLIPBOARD,
            text,
        });
    }
    /** Download a file. Opens the OS share sheet so user can choose save location. */
    async download(options) {
        const result = await this.session.sendRequest({
            type: MiniappRequestType.DOWNLOAD,
            ...options,
        });
        return result ?? { success: false };
    }
}
//# sourceMappingURL=system.js.map