/**
 * @mentra/miniapp/background — background-side SDK entry point.
 *
 * Imported from a miniapp's `src/background/index.ts` to access the
 * per-miniapp `MiniappSession` and its typed `session.*` module
 * wrappers. This is the **always-running JSContext side** of a two-layer
 * miniapp.
 *
 * What's NOT in this entry point:
 *   - `mentra` WebView global (UI-only — import from `@mentra/miniapp/ui`).
 *   - `MentraProvider` / React hooks (UI-only).
 *   - Any DOM-bound API. The JSContext has no DOM.
 *
 * Importing the wrong sub-path is caught at compile time by the
 * separate type-roots on each `exports` entry.
 */
export { MiniappSession, type MiniappSessionOptions } from "../session";
export { registerMiniapp, type MiniappInitHandler } from "./register";
export type { TranscriptionData, TranslationData, ButtonPressData, AudioChunkData, VadData, BatteryData, ConnectionData, WifiData, HeadPositionData, AccelData, LocationData, PhoneNotificationData, NotificationDismissedData, CalendarEventData, HeadingData, TouchData, UnsubscribeFn, } from "../modules/events";
export { MiniappRequestType, MiniappResponseType, MiniappStreamType, MiniappErrorCode } from "../protocol";
export type { ActionContext, ActionHandler, InvokeOptions } from "../modules/actions";
export type { DisplayManager } from "../modules/display";
export type { CanvasManager } from "../modules/canvas";
export type { CameraFovPreset, CameraFovRequest, CameraFovResult, CameraModule, CameraRoiPosition, SetCameraFovOptions, } from "../modules/camera";
export type { CloudClientAudioTransport, CloudClientConnectionStatus, CloudClientStatus, CloudModule, } from "../modules/cloud";
export type { DashboardAPI } from "../modules/dashboard";
export type { GlassesModule } from "../modules/glasses";
export type { HeadingModule } from "../modules/heading";
export type { ImuModule } from "../modules/imu";
export type { InputModule } from "../modules/input";
export type { LedModule } from "../modules/led";
export type { LocationModule } from "../modules/location";
export type { MicModule } from "../modules/mic";
export type { NavigationModule } from "../modules/navigation";
export type { PermissionsModule } from "../modules/permissions";
export type { PhoneModule } from "../modules/phone";
export type { SimpleStorage } from "../modules/storage";
export { BlobModule, BlobWriter, BlobReader, BLOB_WRITE_CHUNK_BYTES, BLOB_READ_ALL_MAX_BYTES } from "../modules/blob";
export type { BlobMeta, BlobSetOptions, BlobSetFromUrlOptions, BlobImportOptions } from "../modules/blob";
export { bytesToBase64, base64ToBytes } from "../modules/base64";
export type { SpeakerModule } from "../modules/speaker";
export type { StreamModule } from "../modules/stream";
export type { SystemModule } from "../modules/system";
export type { TranscriptionModule } from "../modules/transcription";
export type { TranslationModule } from "../modules/translation";
export type { UIModule, UIChannelHandler, UIUnsubscribe } from "../modules/ui";
export type { Rpc, IsRpc, RpcReq, RpcRes, RpcRequestOptions, RpcHandlerContext } from "../modules/ui";
export { MentraRpcError, MentraRpcTimeoutError } from "../modules/ui";
export type { LedColor, LedControlOptions } from "../modules/led";
export type { ViewType, LayoutType, Layout, DisplayOptions, TextWall, DoubleTextWall, ReferenceCard, DashboardCard, BitmapView, ClearView, } from "../modules/display";
export type { DashboardMode } from "../modules/dashboard";
export type { PlayAudioOptions, SpeakOptions, SpeakResult, SpeakerState, SpeakerStateEvent } from "../modules/speaker";
export type { ShareOptions, ShareResult, DownloadOptions, DownloadResult } from "../modules/system";
export type { TranscriptionConfig } from "../modules/transcription";
export type { PermissionErrorEvent } from "../modules/permissions";
export type { AuthUpdatePayload, MiniappVisibility, PermissionType, PermissionRecord, GlassesCapabilities, ConnectAckPayload, MiniappAuthState, MiniappRequestError, } from "../session";
export type { AuthFetchOptions, AuthModule } from "../modules/auth";
export type { MiniappColorScheme } from "../globals";
export type { LatLng, TravelMode, ManeuverKind, RouteAvoidances, NavManeuver, NavOffRoute, NavRerouting, NavArrived, NavError, NavUpdate, NavRoute, PivotOptions, Pivot, PivotEvent, NavStep, NavigationDev, StartNavigationOptions, NavState, NavPermissionResult, ComputeRouteOptions, ComputedRouteStep, ComputedRoute, ComputeRouteResult, } from "../modules/navigation";
//# sourceMappingURL=index.d.ts.map