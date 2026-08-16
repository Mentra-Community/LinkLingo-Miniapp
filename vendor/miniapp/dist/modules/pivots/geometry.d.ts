/**
 * @fileoverview Private geometry helpers for the pivot engine.
 *
 * Lifted (with light edits) from the Navigation miniapp's
 * `src/client/lib/geometry/{geometry,pivots}.ts`. Lives inside the
 * SDK now so the public `navigation.getPivots()` / `onPivot()` APIs
 * are fully self-contained — no consumer has to ship its own
 * polyline-simplification + pivot-extraction code.
 *
 * Not exported from the SDK barrel. Internal only.
 */
import type { LatLng } from "../navigation";
export type PivotDirection = "left" | "right";
/** Raw pivot returned by `extractPivots` — pre-enrichment, geometry only. */
export type RawPivot = {
    lat: number;
    lng: number;
    direction: PivotDirection;
    /** Index of this point in the *simplified* polyline (post-RDP). */
    simplifiedRouteIndex: number;
    /** Approximate index in the ORIGINAL polyline (pre-RDP). Best-effort lookup. */
    rawRouteIndex: number;
    /** Signed heading delta in degrees: +right, -left. */
    headingDelta: number;
};
/** Great-circle distance in meters (haversine). */
export declare function haversineMeters(a: LatLng, b: LatLng): number;
/** Compass bearing from `a` to `b`, in degrees [0, 360). */
export declare function bearingDeg(a: LatLng, b: LatLng): number;
/** Smallest signed difference: target - actual, in [-180, 180]. */
export declare function signedAngleDiff(target: number, actual: number): number;
/**
 * Extract raw turn pivots from a polyline. Returns a sparse list of
 * meaningful turns — STRAIGHT segments, polyline noise, and tiny
 * wobbles are filtered out.
 *
 * Algorithm:
 *   1. RDP-simplify with epsilon = 5m
 *   2. Accumulate consecutive same-direction bends into runs
 *   3. Emit one pivot per run whose summed heading delta clears 25°
 *   4. Merge same-direction pivots within 25m of each other
 */
export declare function extractPivots(rawPoints: LatLng[]): RawPivot[];
/** Raw crossing leg returned by `extractCrossings`. */
export type RawCrossing = {
    /** Polyline index of the curb on the user's current sidewalk (start of leg). */
    startIndex: number;
    /** Polyline index of the curb on the far sidewalk (end of leg). */
    endIndex: number;
    /** Coords at startIndex, surfaced for convenience. */
    lat: number;
    lng: number;
};
/**
 * Detect crosswalk-shaped micro-legs in a route polyline. A crossing
 * is a short leg (<maxLegMeters) that turns sharply (>minBendDeg) off
 * the previous leg and is followed by a sharp turn *back* to roughly
 * the original direction — the classic "step off the sidewalk → walk
 * across → step back onto the sidewalk" shape.
 *
 * The shape check alone isn't enough though: at every intersection
 * Google's polyline traces small perpendicular curb-cut bends even when
 * the user is walking straight through on the SAME sidewalk. To filter
 * those out we also require a meaningful perpendicular displacement —
 * the route after the crossing must continue on the OTHER side of the
 * pre-crossing path, not curve back onto it.
 *
 * Returns each crossing as the polyline indices that bracket the leg
 * we'd skip. The engine wraps each into a synthetic `CROSS_STREET`
 * pivot so glasses HUDs can announce "Cross the road" alongside the
 * usual turn maneuvers.
 */
export declare function extractCrossings(points: LatLng[], opts?: {
    maxLegMeters?: number;
    minBendDeg?: number;
    minSidewalkSwitchMeters?: number;
}): RawCrossing[];
/**
 * Cumulative haversine distance along a polyline from index 0 to
 * each point. Returned array is the same length as `points` —
 * `cumulative[i]` is meters from start to `points[i]`.
 */
export declare function cumulativeDistances(points: LatLng[]): number[];
//# sourceMappingURL=geometry.d.ts.map