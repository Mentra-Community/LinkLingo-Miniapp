/**
 * @fileoverview Pivot engine — internal to NavigationModule.
 *
 * Owns the per-trip pivot list and the cursor that walks it as GPS
 * ticks come in. Public consumers of the SDK never touch this class
 * directly — they go through `navigation.onPivot()` / `getPivots()` /
 * `getActivePivot()` / `getUpcomingPivot()`.
 *
 * Lifecycle:
 *   - `reset()` on `navigation.start()`. Clears pivot list, cursor,
 *     all subscribers stay attached.
 *   - `setRoute(route)` on the first `onRoute` after start, and on
 *     every subsequent reroute. Rebuilds the pivot list from
 *     scratch.
 *   - `onLocationUpdate(coords)` on every GPS fix. Computes which
 *     events to fire and emits them to subscribers.
 *   - `reset()` on `stop()` / `arrived`.
 *
 * The engine doesn't subscribe to GPS itself — `NavigationModule`
 * owns that, calling `onLocationUpdate(coords)` from its own GPS
 * subscription. Keeps this class pure-state with no side effects.
 */
import type { LatLng, ManeuverKind, NavRoute, Pivot, PivotEvent, PivotOptions, TravelMode } from "../navigation";
import { bearingDeg, haversineMeters, signedAngleDiff } from "./geometry";
type Subscriber = (event: PivotEvent) => void;
export declare class PivotEngine {
    private opts;
    private pivots;
    private states;
    /** Index of the next pivot we expect the user to encounter. */
    private cursor;
    /** Pivot currently between `entered` and `exited`, or null. */
    private activePivotIndex;
    /**
     * Latest route polyline + its cumulative-distance array. Retained
     * after `setRoute()` so `onLocationUpdate` can project the user onto
     * the path and compare along-path distance to each pivot's
     * `distanceAlongRouteMeters`. This is what makes a pedestrian on the
     * wrong sidewalk still trigger the upcoming turn — straight-line
     * distance to the pivot point would miss it.
     */
    private points;
    private cumulative;
    /**
     * Async road-name resolver injected by NavigationModule. Backs the
     * engine's last-resort fallback: when a pivot's `fromRoad` or
     * `toRoad` is null after Routes-API instruction parsing, the
     * engine samples a coordinate ~SAMPLE_OFFSET_M behind/ahead along
     * the polyline and asks the host to reverse-geocode it. Patched
     * onto the pivot in place when the response lands. Null when no
     * resolver is wired — the engine simply leaves the field null.
     */
    private roadNameResolver;
    /**
     * Generation counter bumped on every route rebuild. Geocode
     * responses from a stale route are discarded by comparing the
     * generation captured at request time against the current value.
     * Without this, a slow geocode reply from a previous route can
     * stamp a fresh route's pivot with the wrong road name.
     */
    private routeGeneration;
    private subscribers;
    constructor(mode: TravelMode, opts: PivotOptions | undefined);
    /** Replace the trip-level options. Used if `start()` is called
     *  with new options without a full reset. */
    updateOptions(mode: TravelMode, opts: PivotOptions | undefined): void;
    /**
     * Install the host-backed reverse-geocode resolver. NavigationModule
     * calls this once after constructing the engine, wiring through to
     * the host's Geocoding REST adapter. When unset, the engine simply
     * leaves null road names in place — geocoding is a best-effort
     * enhancement, not a requirement.
     */
    setRoadNameResolver(resolver: ((coord: LatLng) => Promise<string | null>) | null): void;
    /**
     * Clear all pivot state. Pivots = []. Cursor reset. Active pivot
     * cleared. Subscribers stay attached so the next `setRoute` can
     * fire events.
     */
    reset(): void;
    /**
     * Rebuild the pivot list from a Routes-API computed step list. This
     * is the high-accuracy path used during live trips: `instruction`
     * strings on each step name the road being entered unambiguously
     * ("Turn left onto Octavia Blvd"), and the explicit `endLat/endLng`
     * gives us the exact corner location without polyline-walking math.
     *
     * NavigationModule calls this once per route lifecycle — at trip
     * start (after firing NAVIGATION_COMPUTE_ROUTE), and again on every
     * reroute. The cursor + state machinery (approaching / entered /
     * exited) is identical to `setRoute` — only the pivot construction
     * differs.
     *
     * If the computed-step list is empty or no pivots survive the
     * filters in `extractPivotsFromComputedSteps`, this falls back to
     * `setRoute(route)` so the geometry-derived pivots are still
     * available. That keeps the engine working on platforms that don't
     * yet have Routes API plumbing.
     */
    setRouteFromComputedSteps(route: NavRoute, computedSteps: Array<{
        lat: number;
        lng: number;
        endLat: number;
        endLng: number;
        distanceMeters: number;
        maneuver?: ManeuverKind;
        instruction?: string;
        /** Host-resolved road name (Phase 1). Optional for backward
         *  compat with callers that only supply `instruction`. */
        road?: string | null;
    }> | undefined): void;
    /**
     * Rebuild the pivot list from a fresh route. Called on every
     * `onRoute` event. Any prior pivot list is discarded; cursor
     * resets to 0.
     */
    setRoute(route: NavRoute, _userPosition: LatLng | null): void;
    /**
     * For every pivot in the current list that has a missing road
     * label, fill it in. Two-stage strategy:
     *
     *   1. **Inherit from neighbors.** Adjacent pivots on the route
     *      share roads by definition: between pivot N and pivot N+1
     *      there are no turns, so pivot N's toRoad == pivot N+1's
     *      fromRoad. If one side is known, copy it. This is free
     *      (no network) and avoids the geocode-mismatch class of bug
     *      where two different sample points return two different
     *      strings for what is conceptually the same road.
     *
     *   2. **Reverse-geocode the remainder.** For any field still
     *      null after inheritance, sample a coordinate ~18m behind
     *      (fromRoad) or ahead (toRoad) along the polyline and ask
     *      the host to reverse-geocode it. Best-effort — failures
     *      leave the field null.
     *
     * The `generation` guard rejects geocode replies arriving after
     * a fresh route rebuild superseded them.
     */
    private _resolveMissingRoadNames;
    /**
     * Drive the cursor with a new GPS fix. Fires `approaching` /
     * `entered` / `exited` as thresholds are crossed.
     *
     * Two distance metrics are used:
     *
     *   1. **Along-path distance** — the user's projected position on the
     *      route polyline gives `userAlong`; each pivot's
     *      `distanceAlongRouteMeters` is its `pivotAlong`. The signed
     *      delta `pivotAlong - userAlong` says how far the user still has
     *      to walk to reach the pivot's perpendicular line (positive =
     *      ahead, negative = past). This is the primary metric for
     *      pedestrians, because it doesn't care which sidewalk they're on
     *      — only that they've crossed the pivot's latitude/longitude
     *      band.
     *
     *   2. **Straight-line distance** — fallback when the user is more
     *      than ON_ROUTE_PERP_TOLERANCE_M from the polyline (they've
     *      really wandered off, not just onto the wrong sidewalk). Keeps
     *      the legacy behavior for that case.
     */
    onLocationUpdate(coords: LatLng): void;
    subscribe(fn: Subscriber): () => void;
    getPivots(): Pivot[];
    getActivePivot(): Pivot | null;
    getUpcomingPivot(): Pivot | null;
    private emit;
}
export { bearingDeg, haversineMeters, signedAngleDiff };
//# sourceMappingURL=engine.d.ts.map