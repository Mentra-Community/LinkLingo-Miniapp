/**
 * Per-request client timings for the gloss path.
 *
 * A gloss is only fully timed once it has rendered, which is after the
 * response the phone is reporting on has already been answered. So each row is
 * completed locally and shipped with the *next* request as
 * `previousRequestMetrics`, carrying its own `requestId` so the server can
 * attach it to the entry it actually describes. Without that id, request N's
 * idle window would be read against request N-1's round trip.
 */

import type {
  GlossClientPrevious,
  GlossClientTelemetry,
  GlossQueueReason,
  GlossTrigger,
} from "../shared/types"
import {CLIENT_BUILD_ID, CLIENT_VERSION, SESSION_ID, newRequestId, nextRequestSeq} from "./identity"

export interface GlossAttempt {
  /** First moment the transcript could have glossed, before cooldown or coalescing. */
  eligibleAt: number
  queueReason: GlossQueueReason
  trigger: GlossTrigger
  utteranceId?: string
}

interface OpenRow {
  requestId: string
  eligibleAt: number
  responseAt?: number
}

export class GlossTelemetry {
  private previous: GlossClientPrevious | null = null
  private open: OpenRow | null = null
  private lastBackendRequestAt: number | null = null

  /**
   * Any call to the backend warms the TLS connection, so transcript reports
   * count toward `networkIdleMs` just as glosses do.
   */
  noteBackendRequest(now = Date.now()): void {
    this.lastBackendRequestAt = now
  }

  /** How stale the connection is; drives the pre-connect decision. */
  msSinceBackendRequest(now = Date.now()): number | undefined {
    return this.lastBackendRequestAt == null ? undefined : now - this.lastBackendRequestAt
  }

  /** Called immediately before the gloss request is sent. */
  begin(attempt: GlossAttempt, now = Date.now()): {requestId: string; client: GlossClientTelemetry} {
    const requestId = newRequestId()
    const networkIdleMs =
      this.lastBackendRequestAt == null ? undefined : Math.max(0, now - this.lastBackendRequestAt)
    this.noteBackendRequest(now)
    this.open = {requestId, eligibleAt: attempt.eligibleAt}

    return {
      requestId,
      client: {
        version: CLIENT_VERSION,
        buildId: CLIENT_BUILD_ID,
        sessionId: SESSION_ID,
        current: {
          requestId,
          requestSeq: nextRequestSeq(),
          utteranceId: attempt.utteranceId,
          trigger: attempt.trigger,
          eligibleAt: attempt.eligibleAt,
          queueReason: attempt.queueReason,
          queueWaitMs: Math.max(0, now - attempt.eligibleAt),
          networkIdleMs,
        },
        previousRequestMetrics: this.previous ?? undefined,
      },
    }
  }

  /**
   * Publishes the row as soon as the response lands rather than waiting for a
   * render, because an error or an empty gloss never paints anything and would
   * otherwise leave a stale snapshot attached to the next request.
   */
  noteResponse(requestId: string, roundTripMs: number, outcome: "ok" | "error", now = Date.now()): void {
    if (this.open?.requestId === requestId) this.open.responseAt = now
    this.previous = {requestId, roundTripMs, outcome}
  }

  /**
   * Amends the published row once the HUD has been handed the new frame. The
   * boundary is "handed to the display bridge", which is as far as the phone
   * can observe.
   */
  noteRendered(requestId: string, now = Date.now()): void {
    const open = this.open
    if (!open || open.requestId !== requestId) return
    if (this.previous?.requestId !== requestId) return
    this.previous = {
      ...this.previous,
      renderMs: open.responseAt == null ? undefined : Math.max(0, now - open.responseAt),
      triggerToRenderMs: Math.max(0, now - open.eligibleAt),
    }
    this.open = null
  }

  /** Test seam. */
  peekPrevious(): GlossClientPrevious | null {
    return this.previous
  }
}

export const glossTelemetry = new GlossTelemetry()
