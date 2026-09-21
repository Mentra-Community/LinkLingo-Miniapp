import {describe, expect, test} from "bun:test"

import {GlossTelemetry} from "./glossTelemetry"

const attempt = {eligibleAt: 1_000, queueReason: "none" as const, trigger: "final" as const}

describe("GlossTelemetry", () => {
  test("queueWaitMs measures from eligibility, not from the request going out", () => {
    const t = new GlossTelemetry()
    const {client} = t.begin({...attempt, eligibleAt: 1_000}, 1_450)
    expect(client.current.queueWaitMs).toBe(450)
  })

  test("the previous call's timings travel with their own request id", () => {
    const t = new GlossTelemetry()
    const first = t.begin(attempt, 1_000)
    t.noteResponse(first.requestId, 380, "ok", 1_380)
    t.noteRendered(first.requestId, 1_390)

    const second = t.begin({...attempt, eligibleAt: 5_000}, 5_000)
    const carried = second.client.previousRequestMetrics
    // The id is what stops request 2's queue wait being read against
    // request 1's round trip.
    expect(carried?.requestId).toBe(first.requestId)
    expect(carried?.requestId).not.toBe(second.requestId)
    expect(carried?.roundTripMs).toBe(380)
    expect(carried?.renderMs).toBe(10)
    expect(carried?.triggerToRenderMs).toBe(390)
  })

  test("a failed call still closes its row so the next request cannot inherit a stale one", () => {
    const t = new GlossTelemetry()
    const first = t.begin(attempt, 1_000)
    t.noteResponse(first.requestId, 60_000, "error", 61_000)
    // No render happens on an error.
    const second = t.begin({...attempt, eligibleAt: 70_000}, 70_000)
    expect(second.client.previousRequestMetrics?.requestId).toBe(first.requestId)
    expect(second.client.previousRequestMetrics?.outcome).toBe("error")
    expect(second.client.previousRequestMetrics?.renderMs).toBeUndefined()
  })

  test("a late render for a superseded request does not overwrite the current row", () => {
    const t = new GlossTelemetry()
    const first = t.begin(attempt, 1_000)
    t.noteResponse(first.requestId, 300, "ok", 1_300)
    const second = t.begin({...attempt, eligibleAt: 2_000}, 2_000)
    t.noteResponse(second.requestId, 200, "ok", 2_200)

    t.noteRendered(first.requestId, 2_500)

    expect(t.peekPrevious()?.requestId).toBe(second.requestId)
    expect(t.peekPrevious()?.roundTripMs).toBe(200)
  })

  test("the first call of a session reports no idle window rather than a fake zero", () => {
    const t = new GlossTelemetry()
    expect(t.begin(attempt, 1_000).client.current.networkIdleMs).toBeUndefined()
  })

  test("a transcript report counts as warming the connection", () => {
    const t = new GlossTelemetry()
    t.noteBackendRequest(1_000)
    // Idle is measured against any backend call, because that is what decides
    // whether the TLS connection is still up.
    expect(t.begin(attempt, 3_000).client.current.networkIdleMs).toBe(2_000)
  })

  test("requestSeq increases so a cold first gloss is separable from a warm tenth", () => {
    const t = new GlossTelemetry()
    const a = t.begin(attempt, 1_000).client.current.requestSeq
    const b = t.begin(attempt, 2_000).client.current.requestSeq
    expect(b).toBe(a + 1)
  })
})
