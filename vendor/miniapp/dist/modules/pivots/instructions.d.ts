/**
 * @fileoverview Routes-API instruction parsing helpers for the pivot
 * engine.
 *
 * The Routes REST API returns per-step `navigationInstruction.instructions`
 * strings like "Turn left onto Octavia Blvd" that unambiguously name the
 * road being entered. Parsing these is the most reliable way to label a
 * turn — more reliable than `StepInfo.road` from the Android Nav SDK,
 * which lags one step behind for the live currentStep + uses a destination
 * placeholder for the arrival leg.
 *
 * Originally lived in the Navigation miniapp's NavigationPage.tsx; moved
 * into the SDK so every miniapp using `navigation.onPivot()` gets the
 * same accurate road names without having to re-implement the parser.
 *
 * All helpers are pure — no side effects, no shared state.
 */
import type { LatLng, ManeuverKind } from "../navigation";
/**
 * Pull a short road name out of a Routes-API instruction string.
 * Instructions look like:
 *   "Turn left onto Octavia Blvd"
 *   "Slight right onto Octavia St"
 *   "Turn right onto Haight St\nDestination will be on the right"
 *
 * Returns null when the parse fails (e.g. instruction is missing, the
 * "onto" clause is absent, or the captured text contains another
 * maneuver verb / direction word). Callers treat null as "no road
 * name available" and hide the label.
 *
 * Only "onto" is matched here — `\bon\b` was previously used as a
 * fallback for depart steps ("Head north on Market St") but it
 * over-matched, capturing maneuver verbs from stacked instructions
 * ("Turn left, then turn right on..."). The depart step is the
 * very first step and is dropped by the slice(0, -1) loop before
 * this parser is called anyway, so removing the fallback costs us
 * nothing real.
 */
export declare function roadNameFromInstruction(instruction?: string | null): string | null;
export declare function sameRoad(a: string, b: string): boolean;
/**
 * Coarse left/right classifier for a maneuver string. Collapses all
 * left variants (TURN_LEFT, SLIGHT_LEFT, SHARP_LEFT, UTURN_LEFT) to
 * "left" and the rights to "right". Returns null when the maneuver
 * isn't a directional turn (STRAIGHT, NAME_CHANGE, ARRIVE, etc.).
 */
export declare function turnDirection(maneuver?: string | null): "left" | "right" | null;
export declare function bendAngleAt(points: LatLng[], junction: LatLng): number | null;
/**
 * Signed polyline bend at a junction. Positive = right turn, negative
 * = left turn, in [-180, 180]. Used to pick a pivot's left/right
 * direction from geometry when the Routes API's first-step maneuver
 * is misleading (e.g. a curb-alignment micro-jog labeled TURN_LEFT
 * right before the real right turn off Hayes onto Gough).
 */
export declare function signedBendAt(points: LatLng[], junction: LatLng): number | null;
/**
 * Minimum bend (degrees) for a junction to count as a real turn worth
 * a pivot. Below this the route is effectively straight through the
 * point; the Routes API may name it as a turn for legal/lane reasons
 * but the user perceives no direction change.
 */
export declare const MIN_TURN_ANGLE_DEG = 30;
/**
 * Shape of a Routes-API computed step (matches `ComputedRouteStep` in
 * the navigation module). Re-declared locally to avoid a circular
 * import; the field set this helper needs is small.
 */
type ComputedStep = {
    lat: number;
    lng: number;
    endLat: number;
    endLng: number;
    distanceMeters: number;
    maneuver?: ManeuverKind;
    instruction?: string;
    /**
     * Pre-resolved road name from the host's hybrid resolver (Phase 1).
     * Preferred over `instruction` parsing when present — same parser
     * runs host-side, just earlier in the pipeline. Older callers that
     * only pass `instruction` still work via the parse fallback below.
     */
    road?: string | null;
};
/**
 * A pivot derived from Routes-API computed steps. Carries the
 * instruction-parsed road labels alongside the geometric corner,
 * ready to be merged into the SDK's `Pivot` shape by the caller.
 *
 * `fromRoad` is required — we drop pivots whose entry road couldn't
 * be parsed. `toRoad` is nullable because the LAST real turn before
 * arrival has a known fromRoad but unknown toRoad (the arrival
 * step's instruction is "Destination will be on the right", no road
 * name in it). The pivot engine treats those nulls as candidates
 * for the reverse-geocode fallback.
 */
export type InstructionPivot = {
    lat: number;
    lng: number;
    fromRoad: string;
    toRoad: string | null;
    direction: "left" | "right" | null;
    maneuver: ManeuverKind;
};
/**
 * Derive accurate turn pivots from a Routes-API step list. Each
 * computed step's `instruction` describes the maneuver that BEGINS
 * that step ("Turn left onto Guerrero St"). A pivot sits at
 * `step[i].end` — the junction where you leave step[i]'s road and
 * turn onto step[i+1]'s road. So for each pair (step[i], step[i+1]):
 *
 *   fromRoad = roadNameFromInstruction(step[i].instruction)
 *   toRoad   = roadNameFromInstruction(step[i+1].instruction)
 *   anchor   = (step[i].endLat, step[i].endLng)
 *   maneuver = step[i+1].maneuver (the actual turn type at the corner)
 *
 * A pivot survives these filters:
 *   1. `fromRoad` parsed successfully from step[i]'s instruction.
 *      Drop the pivot otherwise — we don't know the road the user
 *      came from, and labeling the dot wouldn't make sense.
 *   2. If `toRoad` parsed too, it must differ from `fromRoad` (drop
 *      "stay on same road" jogs). If `toRoad` failed to parse, keep
 *      the pivot with `toRoad: null` so the engine can recover it
 *      via reverse-geocode. This is what keeps the LAST real turn
 *      before arrival in the list — that step's instruction is
 *      "Destination will be on the right" with no road name, but
 *      the turn itself is real and the user needs to see it.
 *   3. The drawn polyline bends ≥ MIN_TURN_ANGLE_DEG at the junction
 *      (drops phantom turns where the geometry is visually straight).
 *
 * The LAST step (the arrival leg itself) is dropped by slice(0, -1) —
 * the destination isn't a turn.
 *
 * Mirrors the Navigation miniapp's preview-turn extraction so live
 * pivots match preview accuracy.
 */
export declare function extractPivotsFromComputedSteps(steps: ComputedStep[] | undefined, polyline: LatLng[]): InstructionPivot[];
export {};
//# sourceMappingURL=instructions.d.ts.map