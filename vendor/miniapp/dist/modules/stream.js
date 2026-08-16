/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Wires to cloud streaming extensions via the __phone__ subscriber path.
 *
 * One entry point: `startStream`. By default it provisions a Mentra-hosted
 * stream and returns playback URLs (managed). Pass `direct` to publish straight
 * to your own ingest URL with no relay.
 */
import { MiniappRequestType } from "../protocol";
export class StreamModule {
    constructor(session) {
        this.session = session;
    }
    /**
     * Start a live video stream from the glasses camera.
     *
     * Managed (default) -- Mentra hosts the stream and the result carries
     * `hlsUrl`/`dashUrl`/`webrtcUrl` for playback. Optionally fan out to your own
     * `destinations`.
     *
     * Direct -- pass `direct` with your own ingest URL; the glasses publish to it
     * and no playback URLs are returned.
     */
    async startStream(options = {}) {
        if (options.direct !== undefined) {
            return this.session.sendRequest({
                type: MiniappRequestType.STREAM_START,
                streamUrl: options.direct,
                video: options.video,
                audio: options.audio,
                sound: options.sound ?? true,
                ...(options.authToken ? { authToken: options.authToken } : {}),
            });
        }
        return this.session.sendRequest({
            type: MiniappRequestType.MANAGED_STREAM_START,
            restreamDestinations: options.destinations,
            video: options.video,
            audio: options.audio,
            sound: options.sound ?? true,
            ingest: options.ingest,
        });
    }
    /** Stop the active stream, or a specific one by `streamId`. */
    async stop(streamId) {
        await this.session.sendRequest({
            type: MiniappRequestType.STREAM_STOP,
            streamId,
        });
    }
}
//# sourceMappingURL=stream.js.map