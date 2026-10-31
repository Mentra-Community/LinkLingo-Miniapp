import {describe, expect, test} from "bun:test"

import type {LearningEvent} from "../shared/mandarin-contract"
import {createLearningTransport, learningUrl, parseIngestResponse} from "./learningTransport"

const event = {eventId: "evt_00000001", text: "你好"} as unknown as LearningEvent

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}})
}

function transport(handler: (path: string, init: RequestInit) => Promise<Response> | Response, timeoutMs = 200) {
  const calls: Array<{path: string; init: RequestInit}> = []
  const t = createLearningTransport({
    authFetch: async (path, init) => {
      calls.push({path, init})
      return handler(path, init)
    },
    timeoutMs,
  })
  return {t, calls}
}

describe("learningUrl", () => {
  test("joins without doubling slashes", () => {
    expect(learningUrl("/api/learning/events", "https://x.example/")).toBe("https://x.example/api/learning/events")
    expect(learningUrl("/api/learning/status", "http://localhost:3240")).toBe(
      "http://localhost:3240/api/learning/status",
    )
  })
})

describe("send", () => {
  test("posts the envelope to /api/learning/events and maps a 200 to accepted/rejected", async () => {
    const {t, calls} = transport(() =>
      json(200, {
        schemaVersion: 1,
        accepted: ["evt_00000001"],
        rejected: [{eventId: "evt_00000002", reason: "bad", permanent: true}],
        connected: true,
      }),
    )
    const result = await t.send([event])
    expect(result).toEqual({
      kind: "ok",
      accepted: ["evt_00000001"],
      rejected: [{eventId: "evt_00000002", reason: "bad", permanent: true}],
    })
    expect(calls[0]!.path).toBe("/api/learning/events")
    expect(calls[0]!.init.method).toBe("POST")
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({schemaVersion: 1, events: [event]})
  })

  test("401 is an auth failure", async () => {
    expect((await transport(() => json(401, {error: "unauthorized"})).t.send([event])).kind).toBe("auth")
  })

  test("403 not_connected is not_connected; any other 403 is an auth failure", async () => {
    expect((await transport(() => json(403, {error: "not_connected"})).t.send([event])).kind).toBe("not_connected")
    expect((await transport(() => json(403, {error: "forbidden"})).t.send([event])).kind).toBe("auth")
    expect((await transport(() => new Response("nope", {status: 403})).t.send([event])).kind).toBe("auth")
  })

  test("5xx, 429, 404 and network errors are transient", async () => {
    for (const status of [500, 502, 503, 429, 404, 408]) {
      expect((await transport(() => json(status, {})).t.send([event])).kind).toBe("transient")
    }
    const failing = transport(() => {
      throw new Error("offline")
    })
    expect(await failing.t.send([event])).toEqual({kind: "transient", error: "offline"})
  })

  test("a request that never answers is a transient timeout", async () => {
    const {t} = transport(() => new Promise<Response>(() => {}), 20)
    const result = await t.send([event])
    expect(result.kind).toBe("transient")
  })

  test("400/413/422 mean the batch itself was refused", async () => {
    for (const status of [400, 413, 422]) {
      expect(await transport(() => json(status, {error: "bad_request"})).t.send([event])).toMatchObject({
        kind: "batch_rejected",
        status,
      })
    }
  })

  test("a 200 with an unexpected body acknowledges nothing", async () => {
    for (const body of [null, {}, {schemaVersion: 2, accepted: []}, {schemaVersion: 1, accepted: "all"}, "ok"]) {
      expect((await transport(() => json(200, body)).t.send([event])).kind).toBe("transient")
    }
  })
})

describe("parseIngestResponse", () => {
  test("keeps only string ids and treats a rejection as permanent unless the server says otherwise", () => {
    expect(
      parseIngestResponse({
        schemaVersion: 1,
        accepted: ["a", 3, null],
        rejected: [
          {eventId: "b", reason: "x"},
          {reason: "no id"},
          {eventId: "c", reason: "y", permanent: true},
          {eventId: "d", reason: "z", permanent: false},
        ],
      }),
    ).toEqual({
      kind: "ok",
      accepted: ["a"],
      rejected: [
        {eventId: "b", reason: "x", permanent: true},
        {eventId: "c", reason: "y", permanent: true},
        {eventId: "d", reason: "z", permanent: false},
      ],
    })
  })
})

describe("fetchStatus", () => {
  test("maps the status body", async () => {
    const {t, calls} = transport(() =>
      json(200, {
        connected: true,
        enabled: true,
        label: "Mandarin app",
        environment: "dev",
        lastAcceptedAt: 1_700_000_000_000,
        lastError: null,
      }),
    )
    const result = await t.fetchStatus()
    expect(result).toEqual({
      ok: true,
      status: {
        connected: true,
        enabled: true,
        label: "Mandarin app",
        environment: "dev",
        lastAcceptedAt: 1_700_000_000_000,
        lastError: null,
      },
    })
    expect(calls[0]!.path).toBe("/api/learning/status")
    expect(calls[0]!.init.method).toBe("GET")
  })

  test("a failed poll is reported as a failure, never as 'not connected'", async () => {
    expect(await transport(() => json(500, {})).t.fetchStatus()).toMatchObject({ok: false, kind: "transient"})
    expect(await transport(() => json(401, {})).t.fetchStatus()).toMatchObject({ok: false, kind: "auth"})
    expect(await transport(() => json(200, {nope: true})).t.fetchStatus()).toMatchObject({ok: false})
    const failing = transport(() => {
      throw new Error("offline")
    })
    expect(await failing.t.fetchStatus()).toMatchObject({ok: false, kind: "transient"})
  })
})

describe("postPhoneStatus", () => {
  test("posts the status body and never throws", async () => {
    const {t, calls} = transport(() => json(200, {}))
    const body = {state: "listening" as const, pending: 2, gaps: [], quarantined: 0, lastError: null}
    expect(await t.postPhoneStatus(body)).toBe(true)
    expect(calls[0]!.path).toBe("/api/learning/phone-status")
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(body)
    expect(await transport(() => json(500, {})).t.postPhoneStatus(body)).toBe(false)
    const failing = transport(() => {
      throw new Error("offline")
    })
    expect(await failing.t.postPhoneStatus(body)).toBe(false)
  })
})

describe("backend contract alignment", () => {
  test("a rejected entry without a permanent flag is treated as permanent, so it leaves the queue", () => {
    const result = parseIngestResponse({
      schemaVersion: 1,
      accepted: [],
      rejected: [{eventId: "evt_00000001", reason: "malformed"}],
    })
    expect(result).toEqual({
      kind: "ok",
      accepted: [],
      rejected: [{eventId: "evt_00000001", reason: "malformed", permanent: true}],
    })
  })

  test("the status poll reads lastAcceptedAt as an ISO time or epoch milliseconds", async () => {
    const iso = "2026-10-11T07:58:00.000Z"
    const a = transport(() =>
      json(200, {
        connected: true,
        enabled: true,
        label: "Mandarin",
        environment: "dev",
        lastAcceptedAt: iso,
        lastError: null,
      }),
    )
    const first = await a.t.fetchStatus()
    expect(first.ok && first.status.lastAcceptedAt).toBe(Date.parse(iso))
    const b = transport(() => json(200, {connected: true, lastAcceptedAt: 1_700_000_000_000}))
    const second = await b.t.fetchStatus()
    expect(second.ok && second.status.lastAcceptedAt).toBe(1_700_000_000_000)
    const c = transport(() => json(200, {connected: false, lastAcceptedAt: null}))
    const third = await c.t.fetchStatus()
    expect(third.ok && third.status.lastAcceptedAt).toBeNull()
  })
})

describe("pairing", () => {
  test("posts only the trimmed code to the pairing path, in the body", async () => {
    const {t, calls} = transport(() => json(200, {connected: true, label: "Mandarin", environment: "dev"}))
    const result = await t.pair("  mps_abcdefghijklmnopqrstuvwx  ")
    expect(result).toEqual({ok: true, message: "Connected to Mandarin."})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe("/api/learning/pair")
    expect(calls[0]!.path).not.toContain("mps_")
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({secret: "mps_abcdefghijklmnopqrstuvwx"})
  })

  test("an invalid code, an expired sign-in, and an outage each produce a distinct message", async () => {
    const invalid = await transport(() =>
      json(400, {error: "pairing_invalid", message: "This pairing code is invalid, expired, or already used."}),
    ).t.pair("mps_x")
    expect(invalid).toEqual({ok: false, message: "This pairing code is invalid, expired, or already used."})
    const signedOut = await transport(() => json(401, {error: "missing bearer token"})).t.pair("mps_x")
    expect(signedOut.ok).toBe(false)
    expect(signedOut.message).toContain("Sign-in expired")
    const down = await transport(() => {
      throw new Error("network down")
    }).t.pair("mps_x")
    expect(down.ok).toBe(false)
    expect(down.message).toContain("Could not reach LinkLingo")
    const server = await transport(() => json(502, {})).t.pair("mps_x")
    expect(server).toEqual({ok: false, message: "Pairing failed (502). Try again."})
  })
})
