/**
 * NavigationModule — turn-by-turn navigation for miniapps. A thin pass-through over the bridge;
 * the phone-side daemon owns the trip lifecycle.
 *
 * Works on iOS and Android (both back it with the Mapbox Navigation SDK). Every Promise
 * resolves with an `{ok, error?}` shape; nothing throws, so check `result.ok`.
 */
import { MiniappSession } from "../session";
import type { UnsubscribeFn } from "./events";
export type LatLng = {
    lat: number;
    lng: number;
};
export type TravelMode = "walking" | "driving" | "cycling" | "two_wheeler";
/**
 * Categorical maneuver vocabulary. Most values come from the Google Nav SDK + Routes API;
 * "CROSS_STREET" is SDK-synthesized when the pivot engine detects a crosswalk leg.
 */
export type ManeuverKind = "STRAIGHT" | "CONTINUE" | "SLIGHT_LEFT" | "SLIGHT_RIGHT" | "TURN_LEFT" | "TURN_RIGHT" | "SHARP_LEFT" | "SHARP_RIGHT" | "U_TURN" | "NAME_CHANGE" | "DEPART" | "ARRIVE" | "CROSS_STREET";
/** Routing preferences. All flags default to false. */
export type RouteAvoidances = {
    highways?: boolean;
    tolls?: boolean;
    ferries?: boolean;
};
export type NavManeuver = {
    kind: "maneuver";
    maneuverType: ManeuverKind;
    /** Meters to the maneuver. -1 if unknown. */
    distanceMeters: number;
    /** Road the user is currently on. Null when unnamed or pre-first-update. */
    fromRoad?: string | null;
    /** Legacy "next road" field. Prefer `nextStepRoad` for new UIs. */
    toRoad?: string | null;
    /** Road the user will be on AFTER the maneuver. Use as the "next street" label. */
    nextStepRoad?: string | null;
    /** Total meters to the destination. -1 if unknown. */
    distanceToDestinationMeters?: number;
    /** Remaining travel time in seconds. -1 if unknown. */
    timeToDestinationSeconds?: number;
    /** Current speed in m/s. Null if unavailable. */
    currentSpeedMps?: number | null;
    /** Speed limit in m/s. Null if unknown / not regulated. */
    speedLimitMps?: number | null;
    /** Route bearing at the user's position, 0–360. Null if unknown. */
    routeHeadingDeg?: number | null;
    /** Host engine's verbatim instruction (e.g. "Turn left onto Waller St"). Render as-is. */
    instruction?: string | null;
};
export type NavOffRoute = {
    kind: "off_route";
    /** Approximate perpendicular distance from the route, in meters. */
    offRouteDistanceMeters: number;
};
export type NavRerouting = {
    kind: "rerouting";
};
export type NavArrived = {
    kind: "arrived";
};
export type NavError = {
    kind: "error";
    message: string;
};
export type NavUpdate = NavManeuver | NavOffRoute | NavRerouting | NavArrived | NavError;
export type NavRoute = {
    points: LatLng[];
    totalDistanceMeters?: number;
    totalDurationSeconds?: number;
    /** Ordered navigable segments. Omitted by older hosts that don't supply step metadata. */
    steps?: NavStep[];
};
/** Pivot-detection tuning. Omitted fields use mode-aware defaults. */
export type PivotOptions = {
    /** "Turning now" radius. Defaults: walking 7, cycling 15, driving 40. */
    radiusMeters?: number;
    /** "Approaching" radius. Defaults: walking 100, cycling 300, driving 800. */
    approachThresholdMeters?: number;
};
/** A real turn along the route, derived once per route build (re-derived on reroute). */
export type Pivot = {
    /** 0-based ordinal; invalidated when `onRoute` fires again. */
    index: number;
    lat: number;
    lng: number;
    direction: "left" | "right";
    /** Road approaching the pivot. Null when the engine has no name. */
    fromRoad: string | null;
    /** Road exiting the pivot. Same null semantics. */
    toRoad: string | null;
    maneuver: ManeuverKind;
    /** Meters from trip start to this pivot, along the route. */
    distanceAlongRouteMeters: number;
    /** "Turning now" radius for this pivot, in meters. */
    radiusMeters: number;
};
/** Each pivot fires `approaching` → `entered` → `exited` (once each), then the cursor advances. */
export type PivotEvent = {
    kind: "approaching";
    pivot: Pivot;
    distanceMeters: number;
} | {
    kind: "entered";
    pivot: Pivot;
} | {
    kind: "exited";
    pivot: Pivot;
};
/** One route leg: a stretch of road ending in a maneuver. */
export type NavStep = {
    /** Coordinate where this step begins (== end of the previous step). */
    lat: number;
    lng: number;
    /** Index into `NavRoute.points[]` where this step starts. */
    routeIndex: number;
    /** Road traversed during this step. Null when unnamed. */
    road?: string | null;
    /** Maneuver performed at the END of this step. */
    maneuver: ManeuverKind;
    distanceMeters: number;
};
/** One type-ahead place suggestion from `placeAutocomplete`. */
export type NavPlaceSuggestion = {
    /** Opaque id to feed into `placeDetails`. */
    placeId: string;
    /** Primary line, e.g. "Blue Bottle Coffee". */
    mainText: string;
    /** Secondary line, e.g. "66 Mint St, San Francisco". Empty when none. */
    secondaryText: string;
};
/** A place resolved from a suggestion via `placeDetails` — has coordinates to route to. */
export type NavPlaceDetails = {
    placeId: string;
    name: string;
    address: string;
    lat: number;
    lng: number;
};
export type NavigationDev = {
    deviate(offsetMeters?: number): void;
    setWrongSidewalkOffset(enabled: boolean): void;
    setSkipCrossings(enabled: boolean): void;
};
export type StartNavigationOptions = {
    /** Single-destination shorthand. Rewritten to `stops: [{lat, lng}]`. */
    lat?: number;
    lng?: number;
    /** Ordered stops; last is the final destination. Must have ≥1 entry. */
    stops?: LatLng[];
    /** Defaults to "driving". */
    mode?: TravelMode;
    avoid?: RouteAvoidances;
    /** Dev/testing only — fake walking the route at speedMultiplier×. */
    simulate?: boolean;
    speedMultiplier?: number;
    /** Override the default pivot-detection knobs for this trip. */
    pivots?: PivotOptions;
    /** Reroute once the user is this many meters past a missed pivot. Omit / 0 to use host defaults. */
    missedTurnRerouteMeters?: number;
};
/** Snapshot of the active trip, shaped like the streaming events so mid-trip opens render the same. */
export type NavState = {
    active: boolean;
    mode?: TravelMode;
    stops?: LatLng[];
    /** Index of the stop currently being navigated to (0 = first). */
    currentStopIndex?: number;
    route?: NavRoute;
    maneuver?: NavManeuver;
    distanceToDestinationMeters?: number;
    timeToDestinationSeconds?: number;
    currentSpeedMps?: number | null;
    speedLimitMps?: number | null;
};
export type NavPermissionResult = {
    /** True if the request reached the host. False e.g. when LOCATION isn't declared in the manifest. */
    ok: boolean;
    /** True if the user accepted the Nav SDK T&Cs (always true on platforms without a T&C gate). */
    accepted: boolean;
    error?: string;
};
/** Standalone route compute — does NOT start a trip. */
export type ComputeRouteOptions = {
    origin: LatLng;
    /** ≥1 entry; last is the final destination. */
    stops: LatLng[];
    /** Defaults to "driving". */
    mode?: TravelMode;
    avoid?: RouteAvoidances;
    /** Up to N alternate routes (engine-permitting). Default 1. */
    alternatives?: number;
};
/** One step of a previewed route, available BEFORE `start()`. Maneuver ENDS the segment. */
export type ComputedRouteStep = {
    lat: number;
    lng: number;
    endLat: number;
    endLng: number;
    distanceMeters: number;
    maneuver?: ManeuverKind;
    /** Full instruction from the Routes API (e.g. "Turn left onto Fell St"). */
    instruction?: string;
    /** Resolved road name. Prefer this over parsing `instruction`. Null when none found. */
    road?: string | null;
};
export type ComputedRoute = {
    points: LatLng[];
    totalDistanceMeters: number;
    totalDurationSeconds: number;
    summary?: string;
    steps?: ComputedRouteStep[];
};
export type ComputeRouteResult = {
    ok: boolean;
    error?: string;
    /** Primary route first, alternates after. */
    routes?: ComputedRoute[];
};
export declare class NavigationModule {
    private readonly session;
    private _pivots;
    /** Subscriptions owned while a trip is active. Released on stop(). */
    private _tripUnsubs;
    /** Trip params captured at start() so reroutes can re-issue computeRoute. */
    private _tripStops;
    private _tripMode;
    private _tripAvoid;
    /** Bumps per request so a stale reply from before a newer reroute is ignored. */
    private _computeRouteSeq;
    /** Latest GPS position, used as the origin for reroute computeRoute calls. */
    private _lastUserPosition;
    constructor(session: MiniappSession);
    /** True iff `LOCATION` is declared in the miniapp's manifest. */
    get hasPermission(): boolean;
    /**
     * Trigger the Nav SDK Terms & Conditions dialog up front, before the user hits "start".
     * Idempotent. Resolves `{ok: false, accepted: false, error}` when LOCATION isn't declared.
     */
    requestPermission(): Promise<NavPermissionResult>;
    /**
     * Start a navigation session. Pass `{lat, lng}` or `{stops: [...]}`. `{ok: true}` means the
     * daemon accepted the request, not that a route was built — listen via `onUpdate(...)`.
     */
    start(opts: StartNavigationOptions): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** Stop the active session (no-op if none). Fire-and-forget; also detaches pivot tracking. */
    stop(): void;
    /** Dev-only simulator helpers for testing trips. `deviate` works on both platforms;
     *  a few helpers are Android-only and return `{ok: false}` on iOS. */
    get dev(): NavigationDev;
    /** Subscribe to live trip events (maneuver / off_route / rerouting / arrived / error). */
    onUpdate(handler: (update: NavUpdate) => void): UnsubscribeFn;
    /** Subscribe to the route polyline. Fires once per route build (initial + reroute), full path. */
    onRoute(handler: (route: NavRoute) => void): UnsubscribeFn;
    /** Snapshot of the active trip, or `null` when none is running. Use on mount to hydrate state. */
    getState(): Promise<NavState | null>;
    /** Compute a route without starting a trip. Primary route first, alternates after. */
    computeRoute(opts: ComputeRouteOptions): Promise<ComputeRouteResult>;
    /**
     * Reverse-geocode a coordinate into a short road name (`road`) and a full
     * formatted street address (`address`, e.g. "369 Hayes Street, San Francisco,
     * California 94102"). `road` backs the pivot engine's fallback; `address`
     * backs UI labels for dropped pins / POI taps. Each is null when none of that
     * kind is found near the coordinate; `ok: false` is an actual failure.
     *
     * Resolved entirely in the v2 cloud maps service (provider-abstracted, Mapbox
     * today) via the host bridge — the miniapp never holds a maps token or calls a
     * provider directly.
     */
    reverseGeocodeRoad(coord: LatLng): Promise<{
        ok: boolean;
        road?: string | null;
        address?: string | null;
        error?: string;
    }>;
    /**
     * Type-ahead place search. Returns lightweight suggestions for `query`,
     * optionally biased toward `near`. Resolved in the v2 cloud maps service
     * (Mapbox Search Box today) via the host bridge — no maps token in the
     * miniapp. `sessionToken` should be a stable per-search-box-opening string,
     * reused on the following `placeDetails` call, then rotated after a pick, so
     * the keystrokes + the final retrieve bill as one search session.
     *
     * Does NOT require LOCATION permission — it's a text search; `near` is only a
     * ranking bias. Resolves `{ok, suggestions}`; `ok: false` is an actual failure.
     */
    placeAutocomplete(opts: {
        query: string;
        near?: LatLng;
        sessionToken: string;
    }): Promise<{
        ok: boolean;
        suggestions?: NavPlaceSuggestion[];
        error?: string;
    }>;
    /**
     * Resolve a suggestion's `placeId` (from `placeAutocomplete`) to a full place
     * with coordinates. Pass the SAME `sessionToken` used for the autocomplete so
     * the provider closes the billing session. Resolved in the v2 cloud maps
     * service via the host bridge. Resolves `{ok, place}`; `ok: false` is a
     * failure (including an unresolvable id).
     */
    placeDetails(opts: {
        placeId: string;
        sessionToken: string;
    }): Promise<{
        ok: boolean;
        place?: NavPlaceDetails;
        error?: string;
    }>;
    /** Subscribe to pivot events. Each pivot fires once per kind; passed pivots aren't re-evaluated. */
    onPivot(handler: (event: PivotEvent) => void): UnsubscribeFn;
    /** Full pivot list for the active route. Empty before the first `onRoute`. */
    getPivots(): Pivot[];
    /** The pivot the user is currently inside (between `entered` and `exited`), or `null`. */
    getActivePivot(): Pivot | null;
    /** The next pivot ahead, or `null` once every pivot has been passed. */
    getUpcomingPivot(): Pivot | null;
    private _attachPivotTrackingForTrip;
    /** computeRoute for the current trip, using the latest position (or route start) as origin. */
    private _issueComputeRouteForTrip;
    private _detachPivotTracking;
}
//# sourceMappingURL=navigation.d.ts.map