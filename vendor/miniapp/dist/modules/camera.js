/**
 * @fileoverview CameraModule — glasses camera control and photo capture.
 */
import { MiniappRequestType } from "../protocol";
export class CameraModule {
    constructor(session) {
        this.session = session;
    }
    /** True iff `CAMERA` is declared in the miniapp's manifest. */
    get hasPermission() {
        return this.session._hasManifestPermission("CAMERA");
    }
    /**
     * Apply camera FOV/ROI settings on the glasses.
     *
     * Resolves after the ASG client reports that the setting was applied to camera
     * hardware after the restart cooldown. Requires CAMERA permission declared in miniapp.json.
     */
    async setFov(request) {
        return this.session.sendRequest({
            type: MiniappRequestType.CAMERA_FOV,
            ...request,
        });
    }
    /**
     * Take a photo via the glasses camera. Returns a URL to the captured image.
     * Requires CAMERA permission declared in miniapp.json.
     *
     * The photo is uploaded to cloud storage; the returned URL is a short-TTL
     * (~30 minute) signed download URL. If the glasses don't have a camera,
     * the phone-side handler rejects with an error. Check
     * `session.capabilities.hasCamera` before calling.
     */
    async takePhoto(options = {}) {
        return this.session.sendRequest({
            type: MiniappRequestType.PHOTO,
            size: options.size ?? "medium",
            compress: options.compress ?? "none",
            sound: options.sound ?? true,
            saveToGallery: options.saveToGallery ?? false,
            exposureTimeNs: options.exposureTimeNs,
        });
    }
    /**
     * Start recording video on the glasses camera. Returns a `recordingId` to pass
     * to {@link stopVideoRecording} after the glasses report that recording
     * started. Requires CAMERA permission declared in miniapp.json. Check
     * `session.capabilities.hasCamera` before calling.
     *
     * Resolution and frame rate are optional — omit them to use the device's saved
     * button-video settings. Lowering `fps` (e.g. to 5) keeps the glasses cooler
     * during long recordings.
     */
    async startVideoRecording(options = {}) {
        return this.session.sendRequest({
            type: MiniappRequestType.VIDEO_RECORDING_START,
            width: options.width,
            height: options.height,
            fps: options.fps,
            sound: options.sound ?? true,
            save: options.save ?? false,
        });
    }
    /**
     * Stop an in-progress video recording started with {@link startVideoRecording}.
     *
     * By default the recording stays on the glasses. Pass `uploadUrl` to have the
     * glasses upload the finished clip to your own endpoint.
     *
     * @param recordingId The id returned from `startVideoRecording`.
     * @param options     Optional upload destination for the finished recording.
     */
    async stopVideoRecording(recordingId, options = {}) {
        await this.session.sendRequest({
            type: MiniappRequestType.VIDEO_RECORDING_STOP,
            recordingId,
            uploadUrl: options.uploadUrl,
            uploadAuthToken: options.uploadAuthToken,
        });
    }
}
//# sourceMappingURL=camera.js.map