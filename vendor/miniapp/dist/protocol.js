/**
 * @fileoverview Wire protocol for @mentra/miniapp.
 *
 * Fresh miniapp-naming enum values. No legacy tpa_/app_/applet_ prefixes.
 * These values are the contract between @mentra/miniapp (running in a WebView)
 * and LocalMiniappRuntime (running on the phone).
 *
 * IMPORTANT: This file has NO runtime dependency on @mentra/sdk. The cloud SDK's
 * wire protocol enums live in @mentra/sdk/types/message-types.ts and are used
 * for cloud↔app communication, not phone↔miniapp.
 */
// ============================================================================
// Miniapp → phone (request, via bridge envelope)
// ============================================================================
export var MiniappRequestType;
(function (MiniappRequestType) {
    /** Handshake: miniapp announces itself and asks phone to bind the session. */
    MiniappRequestType["CONNECT"] = "miniapp_connect";
    /** Request a fresh miniapp-scoped backend auth token. */
    MiniappRequestType["AUTH_REFRESH"] = "miniapp_auth_refresh";
    /** Update the set of streams the miniapp is subscribed to. */
    MiniappRequestType["SUBSCRIBE"] = "miniapp_subscribe";
    /** Push a layout to the glasses display. */
    MiniappRequestType["DISPLAY"] = "miniapp_display";
    /** Push a canvas command to the glasses canvas. */
    MiniappRequestType["CANVAS"] = "miniapp_canvas";
    /** Play an arbitrary audio URL through the phone's audio playback service. */
    MiniappRequestType["PLAY_AUDIO"] = "miniapp_play_audio";
    /** Stop any audio playback this miniapp initiated. */
    MiniappRequestType["STOP_AUDIO"] = "miniapp_stop_audio";
    /** Speak text via cloud TTS — phone constructs the URL. */
    MiniappRequestType["SPEAK"] = "miniapp_speak";
    /** Control the glasses RGB LED. */
    MiniappRequestType["RGB_LED"] = "miniapp_rgb_led";
    /** One-shot location poll. */
    MiniappRequestType["LOCATION_POLL"] = "miniapp_location_poll";
    /** Start a turn-by-turn navigation trip. Android only. */
    MiniappRequestType["NAVIGATION_START"] = "miniapp_navigation_start";
    /** Stop the active navigation trip (if any). */
    MiniappRequestType["NAVIGATION_STOP"] = "miniapp_navigation_stop";
    /** Dev-only: nudge the simulator off-route to test rerouting. Android sim only. */
    MiniappRequestType["NAVIGATION_DEVIATE"] = "miniapp_navigation_deviate";
    /** Dev-only: lock simulated locations to the wrong sidewalk for pivot-trigger testing. */
    MiniappRequestType["NAVIGATION_SET_WRONG_SIDEWALK"] = "miniapp_navigation_set_wrong_sidewalk";
    /** Dev-only: take over the simulator and walk a polyline with crossings stripped. */
    MiniappRequestType["NAVIGATION_SET_SKIP_CROSSINGS"] = "miniapp_navigation_set_skip_crossings";
    /** Snapshot of the active trip (or null). Lets a miniapp opening mid-trip hydrate. */
    MiniappRequestType["NAVIGATION_GET_STATE"] = "miniapp_navigation_get_state";
    /** Compute a route without starting a trip. Replaces hand-rolled Directions calls. */
    MiniappRequestType["NAVIGATION_COMPUTE_ROUTE"] = "miniapp_navigation_compute_route";
    /** Reverse-geocode a coordinate to a short road name + full formatted
     *  address. `road` backs the engine's fallback for pivots whose Routes-API
     *  instruction didn't include a parseable road; `address` backs UI labels for
     *  dropped pins / POI taps. Resolved in the v2 cloud maps service (Mapbox
     *  today) via the host bridge — the miniapp never holds a maps token. */
    MiniappRequestType["NAVIGATION_REVERSE_GEOCODE"] = "miniapp_navigation_reverse_geocode";
    /** Type-ahead place search (autocomplete). Resolved in the v2 cloud maps
     *  service (Mapbox Search Box today) via the host bridge — the miniapp never
     *  holds a maps token. Pairs with NAVIGATION_PLACE_DETAILS via a sessionToken. */
    MiniappRequestType["NAVIGATION_PLACE_AUTOCOMPLETE"] = "miniapp_navigation_place_autocomplete";
    /** Resolve an autocomplete suggestion (placeId + sessionToken) to coordinates,
     *  in the v2 cloud maps service via the host bridge. */
    MiniappRequestType["NAVIGATION_PLACE_DETAILS"] = "miniapp_navigation_place_details";
    /** Trigger the Google Nav SDK T&C dialog up-front so start() doesn't have to. */
    MiniappRequestType["NAVIGATION_REQUEST_PERMISSION"] = "miniapp_navigation_request_permission";
    /** Phone-local simple storage. */
    MiniappRequestType["STORAGE_GET"] = "miniapp_storage_get";
    MiniappRequestType["STORAGE_SET"] = "miniapp_storage_set";
    MiniappRequestType["STORAGE_DELETE"] = "miniapp_storage_delete";
    MiniappRequestType["STORAGE_LIST"] = "miniapp_storage_list";
    MiniappRequestType["STORAGE_CLEAR"] = "miniapp_storage_clear";
    MiniappRequestType["STORAGE_HAS"] = "miniapp_storage_has";
    MiniappRequestType["STORAGE_GET_ALL"] = "miniapp_storage_get_all";
    MiniappRequestType["STORAGE_SET_MULTIPLE"] = "miniapp_storage_set_multiple";
    MiniappRequestType["STORAGE_FLUSH"] = "miniapp_storage_flush";
    /** Write camera FOV settings. */
    MiniappRequestType["CAMERA_FOV"] = "miniapp_camera_fov";
    /**
     * Enable/disable raw accelerometer (IMU) streaming on the glasses. The
     * accel stream also auto-enables on subscribe; this is an explicit override
     * for callers who want to control the sensor directly. G2 only today.
     */
    MiniappRequestType["IMU_SET_ENABLED"] = "miniapp_imu_set_enabled";
    /** Share content via the OS share sheet. */
    MiniappRequestType["SHARE"] = "miniapp_share";
    /** Open a URL in the system browser. */
    MiniappRequestType["OPEN_URL"] = "miniapp_open_url";
    /** Copy text to the system clipboard. */
    MiniappRequestType["COPY_CLIPBOARD"] = "miniapp_copy_clipboard";
    /** Download a file (triggers OS share sheet for save location). */
    MiniappRequestType["DOWNLOAD"] = "miniapp_download";
    /**
     * Phone-local persistent binary blob storage, scoped to (userId, packageName).
     * Unlike STORAGE_* (small string KV in MMKV), blobs are arbitrary bytes written
     * to the phone filesystem. Large payloads are moved in chunks (BLOB_WRITE /
     * BLOB_READ) so a single bridge message never carries a multi-MB string.
     */
    MiniappRequestType["BLOB_CREATE"] = "miniapp_blob_create";
    MiniappRequestType["BLOB_WRITE"] = "miniapp_blob_write";
    MiniappRequestType["BLOB_COMMIT"] = "miniapp_blob_commit";
    MiniappRequestType["BLOB_ABORT"] = "miniapp_blob_abort";
    MiniappRequestType["BLOB_GET"] = "miniapp_blob_get";
    MiniappRequestType["BLOB_LIST"] = "miniapp_blob_list";
    MiniappRequestType["BLOB_DELETE"] = "miniapp_blob_delete";
    MiniappRequestType["BLOB_CLEAR"] = "miniapp_blob_clear";
    MiniappRequestType["BLOB_USAGE"] = "miniapp_blob_usage";
    MiniappRequestType["BLOB_OPEN_READ"] = "miniapp_blob_open_read";
    MiniappRequestType["BLOB_READ"] = "miniapp_blob_read";
    MiniappRequestType["BLOB_CLOSE_READ"] = "miniapp_blob_close_read";
    /** Download a URL straight into a blob, host-side (no bytes cross the bridge). */
    MiniappRequestType["BLOB_SET_FROM_URL"] = "miniapp_blob_set_from_url";
    /** Open the OS file picker and import the chosen file into a blob, host-side. */
    MiniappRequestType["BLOB_IMPORT"] = "miniapp_blob_import";
    /** Share a stored blob from disk via the OS share sheet (no bytes cross the bridge). */
    MiniappRequestType["BLOB_SHARE"] = "miniapp_blob_share";
    /** Phone → miniapp liveness probe. Miniapp SDK auto-replies with PONG. */
    MiniappRequestType["PING"] = "miniapp_ping";
    /**
     * Apply transcription configuration (language hints, vocabulary, diarization).
     * Phone forwards to the cloud STT layer. Fire-and-forget; cached client-side
     * so future reconnect logic can re-send.
     */
    MiniappRequestType["TRANSCRIPTION_CONFIG"] = "miniapp_transcription_config";
    // ----- Deferred in v1 -----
    /** Dashboard content update. Noop in v1. */
    MiniappRequestType["DASHBOARD_CONTENT_UPDATE"] = "miniapp_dashboard_content_update";
    // ----- Photos, streaming -----
    MiniappRequestType["PHOTO"] = "miniapp_photo";
    MiniappRequestType["VIDEO_RECORDING_START"] = "miniapp_video_recording_start";
    MiniappRequestType["VIDEO_RECORDING_STOP"] = "miniapp_video_recording_stop";
    MiniappRequestType["STREAM_START"] = "miniapp_stream_start";
    MiniappRequestType["STREAM_STOP"] = "miniapp_stream_stop";
    MiniappRequestType["MANAGED_STREAM_START"] = "miniapp_managed_stream_start";
    MiniappRequestType["MANAGED_STREAM_STOP"] = "miniapp_managed_stream_stop";
    /** Ask the host to open the glasses Wi-Fi setup flow (mirrors the cloud SDK's requestWifiSetup). */
    MiniappRequestType["REQUEST_WIFI_SETUP"] = "miniapp_request_wifi_setup";
    // ----- Inter-miniapp interop (SYSTEM apps only) -----
    /** List installed miniapps (compatibility-filtered, with declared actions). */
    MiniappRequestType["MINIAPPS_LIST"] = "miniapp_apps_list";
    /** Start another miniapp (user-tap semantics). */
    MiniappRequestType["MINIAPPS_START"] = "miniapp_apps_start";
    /** Stop another miniapp. */
    MiniappRequestType["MINIAPPS_STOP"] = "miniapp_apps_stop";
    /** Invoke a declared action on another miniapp; headless-wakes it if stopped. */
    MiniappRequestType["ACTION_INVOKE"] = "miniapp_action_invoke";
    /** Target → host: the result of a delivered ACTION_CALL, correlated by callId. */
    MiniappRequestType["ACTION_RESULT"] = "miniapp_action_result";
})(MiniappRequestType || (MiniappRequestType = {}));
// ============================================================================
// Phone → miniapp (response or push)
// ============================================================================
export var MiniappResponseType;
(function (MiniappResponseType) {
    /** Response to CONNECT carrying userId, packageName, capabilities. */
    MiniappResponseType["CONNECT_ACK"] = "miniapp_connect_ack";
    /** Push: a streamed event for a subscribed stream. */
    MiniappResponseType["EVENT"] = "miniapp_event";
    /** Response to any request that needs a result (matched by requestId). */
    MiniappResponseType["REQUEST_RESULT"] = "miniapp_request_result";
    /** Push: glasses capabilities changed. */
    MiniappResponseType["CAPABILITIES_UPDATE"] = "miniapp_capabilities_update";
    /** Push: miniapp's foreground/background state changed. */
    MiniappResponseType["VISIBILITY_CHANGE"] = "miniapp_visibility_change";
    /** Push: host color scheme (light/dark) changed. */
    MiniappResponseType["COLOR_SCHEME_CHANGE"] = "miniapp_color_scheme_change";
    /**
     * Push: speaker playback state transitioned. Per-miniapp; the runtime sends
     * to the owning miniapp only. Carries {state, errorCode?, errorMessage?,
     * durationMs?}. See SpeakerModule.onStateChange().
     */
    MiniappResponseType["SPEAKER_STATE"] = "miniapp_speaker_state";
    /**
     * Push: manifest-declared permissions changed (e.g. dev miniapp re-scanned
     * with updated manifest). Carries a full PermissionRecord. SDK caches it
     * and fires session.permissions.onUpdate handlers.
     */
    MiniappResponseType["PERMISSIONS_UPDATE"] = "miniapp_permissions_update";
    /**
     * Push: miniapp-scoped backend auth token changed. Carries a token minted for
     * this packageName only; it is never a Core or runtime access token.
     */
    MiniappResponseType["AUTH_UPDATE"] = "miniapp_auth_update";
    /** Reply to PING. SDK auto-handles this; developers never see it. */
    MiniappResponseType["PONG"] = "miniapp_pong";
    /**
     * Host → target: deliver an action call (from another miniapp's
     * session.actions.invoke) to this miniapp's session.actions.handle handler.
     * Carries {callId, actionId, params, callerPackageName}. The SDK runs the
     * handler and replies with an ACTION_RESULT request keyed by callId.
     */
    MiniappResponseType["ACTION_CALL"] = "miniapp_action_call";
    /**
     * Push: phone is about to tear down the miniapp's session. Gives the SDK
     * a brief window (~50ms grace on the phone side) to fire one last
     * `sendOneShot` before the transport closes — used to flush final
     * cleanup like `display.clear()`. Synchronous handlers only.
     */
    MiniappResponseType["WILL_DISCONNECT"] = "miniapp_will_disconnect";
    /** Async error not tied to a specific request. */
    MiniappResponseType["ERROR"] = "miniapp_error";
})(MiniappResponseType || (MiniappResponseType = {}));
// ============================================================================
// Stream types a miniapp can subscribe to
// ============================================================================
export var MiniappStreamType;
(function (MiniappStreamType) {
    // Hardware / input events
    MiniappStreamType["BUTTON_PRESS"] = "button_press";
    MiniappStreamType["TOUCH_EVENT"] = "touch_event";
    MiniappStreamType["HEAD_POSITION"] = "head_position";
    /**
     * Raw accelerometer reading from the glasses IMU — `{x, y, z}` in g, plus a
     * timestamp. G2 only today. A richer combined IMU stream (accel + gyro +
     * magnetometer) is future work; this is the single-sensor precursor.
     */
    MiniappStreamType["ACCEL_DATA"] = "accel_data";
    // Status
    MiniappStreamType["GLASSES_BATTERY"] = "glasses_battery";
    MiniappStreamType["PHONE_BATTERY"] = "phone_battery";
    MiniappStreamType["GLASSES_CONNECTION"] = "glasses_connection";
    /** Glasses Wi-Fi state (connected/ssid). Glasses with Wi-Fi only; needed for streaming. */
    MiniappStreamType["GLASSES_WIFI"] = "glasses_wifi";
    // Speech / audio (cloud or local)
    MiniappStreamType["TRANSCRIPTION"] = "transcription";
    MiniappStreamType["TRANSLATION"] = "translation";
    MiniappStreamType["AUDIO_CHUNK"] = "audio_chunk";
    MiniappStreamType["VAD"] = "vad";
    // Phone sensors
    MiniappStreamType["LOCATION_UPDATE"] = "location_update";
    /** Compass heading in degrees (0=N, 90=E). Android only. */
    MiniappStreamType["HEADING_UPDATE"] = "heading_update";
    /** Turn-by-turn navigation event (maneuver / rerouting / arrived / error). */
    MiniappStreamType["NAVIGATION_UPDATE"] = "navigation_update";
    /** Active navigation route polyline — full path, fired once per route build. */
    MiniappStreamType["NAVIGATION_ROUTE"] = "navigation_route";
    MiniappStreamType["PHONE_NOTIFICATION"] = "phone_notification";
    /**
     * A previously-posted notification was dismissed by the user.
     *
     * Android-only today. iOS does not expose dismiss callbacks to apps
     * (Apple privacy restriction); subscribing on iOS succeeds but no events
     * fire. See agents/miniapp-speaker-state-and-notif-dismissed-plan.md.
     */
    MiniappStreamType["PHONE_NOTIFICATION_DISMISSED"] = "phone_notification_dismissed";
    MiniappStreamType["CALENDAR_EVENT"] = "calendar_event";
    // Photos, streaming
    MiniappStreamType["PHOTO_TAKEN"] = "photo_taken";
    MiniappStreamType["STREAM_STATUS"] = "stream_status";
})(MiniappStreamType || (MiniappStreamType = {}));
// ============================================================================
// Error codes
// ============================================================================
export var MiniappErrorCode;
(function (MiniappErrorCode) {
    /** The miniapp subscribed to a stream whose required permission wasn't in its manifest. */
    MiniappErrorCode["PERMISSION_NOT_DECLARED"] = "PERMISSION_NOT_DECLARED";
    /** Request routed to a method that isn't supported yet. */
    MiniappErrorCode["NOT_IMPLEMENTED"] = "NOT_IMPLEMENTED";
    /** Request timed out or the session was torn down before it could complete. */
    MiniappErrorCode["REQUEST_ABORTED"] = "REQUEST_ABORTED";
    /** Phone-side code path threw. Check `message`. */
    MiniappErrorCode["INTERNAL"] = "INTERNAL";
    /** Cloud TTS returned a non-2xx for a SPEAK request. */
    MiniappErrorCode["TTS_TEXT_TOO_LONG"] = "TTS_TEXT_TOO_LONG";
    MiniappErrorCode["TTS_INVALID_VOICE"] = "TTS_INVALID_VOICE";
    MiniappErrorCode["TTS_UPSTREAM_ERROR"] = "TTS_UPSTREAM_ERROR";
    /** Not connected / pre-ACK and transport closed. */
    MiniappErrorCode["NOT_CONNECTED"] = "NOT_CONNECTED";
    // ----- Inter-miniapp interop -----
    /** Caller is not a system app — interop APIs (list/start/stop/invoke) are SYSTEM-only. */
    MiniappErrorCode["NOT_PERMITTED"] = "NOT_PERMITTED";
    /** Target miniapp is not installed. */
    MiniappErrorCode["APP_NOT_FOUND"] = "APP_NOT_FOUND";
    /** Target miniapp is incompatible with the connected glasses. */
    MiniappErrorCode["APP_NOT_COMPATIBLE"] = "APP_NOT_COMPATIBLE";
    /** Target miniapp does not declare the requested action. */
    MiniappErrorCode["ACTION_NOT_FOUND"] = "ACTION_NOT_FOUND";
    /** Target connected but never registered a handler for the action (within the buffer window). */
    MiniappErrorCode["NO_ACTION_HANDLER"] = "NO_ACTION_HANDLER";
    /** Target failed to wake / complete its CONNECT handshake for an invoke. */
    MiniappErrorCode["WAKE_FAILED"] = "WAKE_FAILED";
    /** Action handler did not return within the caller's timeout. */
    MiniappErrorCode["ACTION_TIMEOUT"] = "ACTION_TIMEOUT";
    /** Action params or result exceeded the 256 KB size cap. */
    MiniappErrorCode["PAYLOAD_TOO_LARGE"] = "PAYLOAD_TOO_LARGE";
    // ----- Blob storage / recorder -----
    /** No blob with the given id in this miniapp's namespace. */
    MiniappErrorCode["BLOB_NOT_FOUND"] = "BLOB_NOT_FOUND";
    /** Writing this blob would exceed the per-app blob quota. */
    MiniappErrorCode["BLOB_QUOTA_EXCEEDED"] = "BLOB_QUOTA_EXCEEDED";
    /** Blob is larger than the requested in-memory read can hold. */
    MiniappErrorCode["BLOB_TOO_LARGE"] = "BLOB_TOO_LARGE";
    /** Write/read handle is unknown, already settled, or belongs to another app. */
    MiniappErrorCode["BLOB_HANDLE_INVALID"] = "BLOB_HANDLE_INVALID";
    /** Filesystem write failed (out of disk, permissions, etc.). */
    MiniappErrorCode["BLOB_WRITE_FAILED"] = "BLOB_WRITE_FAILED";
    /** `blob.setFromUrl` could not download the URL (network / non-2xx). */
    MiniappErrorCode["BLOB_DOWNLOAD_FAILED"] = "BLOB_DOWNLOAD_FAILED";
    /** `blob.importFile` failed (not the user cancelling — that resolves to null). */
    MiniappErrorCode["BLOB_IMPORT_FAILED"] = "BLOB_IMPORT_FAILED";
})(MiniappErrorCode || (MiniappErrorCode = {}));
//# sourceMappingURL=protocol.js.map