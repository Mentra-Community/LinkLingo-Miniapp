import {describe, expect, test} from "bun:test"

import {diagnostics} from "./observability"

describe("background diagnostics", () => {
  test("accumulates counters and exposes them in the snapshot", () => {
    const before = diagnostics.snapshot().counters["test.hits"] ?? 0
    diagnostics.increment("test.hits")
    diagnostics.increment("test.hits", 4)
    expect(diagnostics.snapshot().counters["test.hits"]).toBe(before + 5)
  })

  test("summarizes timings as count, average, last, and max", () => {
    diagnostics.observe("test.latency", 100)
    diagnostics.observe("test.latency", 300)
    const timing = diagnostics.snapshot().timings["test.latency"]
    expect(timing).toEqual({count: 2, avgMs: 200, lastMs: 300, maxMs: 300})
  })

  test("ignores nonsensical timing samples", () => {
    diagnostics.observe("test.ignored", -5)
    diagnostics.observe("test.ignored", Number.NaN)
    expect(diagnostics.snapshot().timings["test.ignored"]).toBeUndefined()
  })

  test("remembers the most recent error and counts it", () => {
    const before = diagnostics.snapshot().counters.errors ?? 0
    diagnostics.recordError("Translation quota exhausted")
    const snapshot = diagnostics.snapshot()
    expect(snapshot.lastError).toBe("Translation quota exhausted")
    expect(snapshot.lastErrorAt).toBeGreaterThan(0)
    expect(snapshot.counters.errors).toBe(before + 1)
  })

  test("snapshot counters are a copy, not the live object", () => {
    diagnostics.increment("test.isolated")
    const snapshot = diagnostics.snapshot()
    snapshot.counters["test.isolated"] = 9999
    expect(diagnostics.snapshot().counters["test.isolated"]).not.toBe(9999)
  })
})
