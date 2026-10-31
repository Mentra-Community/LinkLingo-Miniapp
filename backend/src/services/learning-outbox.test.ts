import {describe, expect, test} from "bun:test"

import type {LearningEvent, SourceIdentity} from "../vendor/mandarin-contract"
import {
  LearningService,
  PairError,
  RETRY_WINDOW_MS,
  decryptSecret,
  encryptSecret,
  userKeyFor,
  type LearningConfig,
} from "./learning-outbox"
import type {ObjectStore} from "./tape-store"

class MapStore implements ObjectStore {
  readonly objects = new Map<string, string>()
  failPuts = false
  async put(key: string, body: string) {
    if (this.failPuts) throw new Error("s3 down")
    this.objects.set(key, body)
  }
  async get(key: string) {
    return this.objects.get(key) ?? null
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix))
  }
  async delete(keys: string[]) {
    for (const key of keys) this.objects.delete(key)
  }
  keysUnder(prefix: string) {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix))
  }
}

const KEY = Buffer.alloc(32, 7)
const config: LearningConfig = {
  enabled: true,
  mandarinUrl: "https://mandarin.test",
  serviceKey: "k".repeat(40),
  configKey: KEY,
}
const identity: SourceIdentity = {issuer: "cloud-core", subject: "user-1", environment: "dev"}
const userKey = userKeyFor(identity)
let clockMs = Date.parse("2026-10-11T07:10:00.000Z")

function event(n: number, over: Partial<LearningEvent> = {}): LearningEvent {
  return {
    schemaVersion: 1,
    source: "linklingo",
    sourceSessionId: "session-aaaaaaaa",
    eventId: `event-${String(n).padStart(8, "0")}`,
    sequence: n,
    capturedAt: new Date(Date.parse("2026-10-11T07:00:00.000Z") + n * 1000).toISOString(),
    timezone: "Asia/Shanghai",
    text: `第${n}句`,
    mode: "heard",
    disposition: "heard",
    speakerAttribution: "unknown",
    clientVersion: "1.0.22",
    clientBuildId: "t",
    ...over,
  }
}

type Reply = {status: number; body?: unknown} | Error
function fakeMandarin(handler: (url: string, init: RequestInit) => Reply | Promise<Reply>) {
  const calls: Array<{url: string; body: any; auth: string | null}> = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      auth: new Headers(init.headers).get("authorization"),
    })
    const reply = await handler(url, init)
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body ?? {}), {status: reply.status})
  }) as unknown as typeof fetch
  return {impl, calls}
}

const pairedReply = {
  status: 201,
  body: {connectionId: "conn-aaaaaaaa", deliveryCredential: "mcd_" + "z".repeat(43), ownerLabel: "Nicolo"},
}
const committed = (events: LearningEvent[], outcome = "accepted") => ({
  status: 200,
  body: {schemaVersion: 1, results: events.map((e) => ({eventId: e.eventId, outcome, segmentId: "seg-aaaaaaaa"}))},
})

async function pairedService(handler: (url: string, init: RequestInit) => Reply | Promise<Reply>) {
  const store = new MapStore()
  const mandarin = fakeMandarin((url, init) => (url.endsWith("/pairing/redeem") ? pairedReply : handler(url, init)))
  const service = new LearningService(store, config, {fetch: mandarin.impl, now: () => clockMs, random: () => 0.5})
  await service.pair(identity, "mps_" + "a".repeat(32))
  return {store, mandarin, service}
}

describe("encryption", () => {
  test("round-trips and rejects tampering or a wrong key", () => {
    const sealed = encryptSecret(KEY, "mcd_secret")
    expect(sealed).not.toContain("mcd_secret")
    expect(decryptSecret(KEY, sealed)).toBe("mcd_secret")
    expect(() => decryptSecret(Buffer.alloc(32, 9), sealed)).toThrow()
    const raw = Buffer.from(sealed, "base64")
    raw[raw.length - 1]! ^= 1
    expect(() => decryptSecret(KEY, raw.toString("base64"))).toThrow()
  })
})

describe("pairing", () => {
  test("stores the delivery credential encrypted and sends only verified identity fields", async () => {
    const {store, mandarin} = await pairedService(() => ({status: 200}))
    const body = mandarin.calls[0]!.body
    expect(body.source).toEqual(identity)
    expect(mandarin.calls[0]!.auth).toBe(`Bearer ${config.serviceKey}`)
    const stored = [...store.objects.values()].join("\n")
    expect(stored).not.toContain("mcd_" + "z".repeat(43))
  })

  test("an invalid or expired code becomes a clear error and stores nothing", async () => {
    const store = new MapStore()
    const mandarin = fakeMandarin(() => ({status: 410, body: {error: "pairing_invalid"}}))
    const service = new LearningService(store, config, {fetch: mandarin.impl})
    await expect(service.pair(identity, "mps_" + "a".repeat(32))).rejects.toMatchObject({kind: "invalid"})
    expect(store.objects.size).toBe(0)
    expect((await service.status(identity)).connected).toBe(false)
  })

  test("an unreachable Mandarin server is reported as unavailable, not as a bad code", async () => {
    const service = new LearningService(new MapStore(), config, {fetch: fakeMandarin(() => new Error("down")).impl})
    await expect(service.pair(identity, "mps_" + "a".repeat(32))).rejects.toBeInstanceOf(PairError)
    await expect(service.pair(identity, "mps_" + "a".repeat(32))).rejects.toMatchObject({kind: "unavailable"})
  })

  test("learning disabled or unconfigured refuses to pair", async () => {
    const service = new LearningService(new MapStore(), {...config, configKey: null})
    await expect(service.pair(identity, "mps_" + "a".repeat(32))).rejects.toMatchObject({kind: "not_configured"})
  })
})

describe("intake (durable acknowledgement)", () => {
  test("accepted events are in storage before enqueue resolves, and a retry does not duplicate them", async () => {
    const {store, service} = await pairedService(() => ({status: 200}))
    const events = [event(0), event(1)]
    const first = await service.enqueue(userKey, events)
    expect(first.accepted).toHaveLength(2)
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(2)
    await service.enqueue(userKey, events)
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(2)
  })

  test("malformed events are rejected individually; valid ones still land", async () => {
    const {store, service} = await pairedService(() => ({status: 200}))
    const result = await service.enqueue(userKey, [
      event(0),
      {eventId: "bad-event-id", text: ""},
      {junk: 1},
      {...event(2), speakerAttribution: "mine"},
    ])
    expect(result.accepted).toEqual([event(0).eventId])
    expect(result.rejected.map((r) => r.eventId)).toEqual(["bad-event-id", "unknown", event(2).eventId])
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(1)
  })

  test("a storage failure rejects the whole batch so nothing is acknowledged", async () => {
    const {store, service} = await pairedService(() => ({status: 200}))
    store.failPuts = true
    await expect(service.enqueue(userKey, [event(0)])).rejects.toThrow("s3 down")
  })
})

describe("delivery", () => {
  test("events are removed only after Mandarin confirms the commit, in capture order", async () => {
    const seen: string[][] = []
    const {store, service} = await pairedService((_url, init) => {
      const events = JSON.parse(String(init.body)).events as LearningEvent[]
      seen.push(events.map((e) => e.eventId))
      return committed(events)
    })
    await service.enqueue(userKey, [event(2), event(0), event(1)])
    const result = await service.drain(userKey)
    expect(result).toMatchObject({delivered: 3, remaining: 0, outcome: "delivered"})
    expect(seen[0]).toEqual([event(0).eventId, event(1).eventId, event(2).eventId])
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(0)
  })

  test("success happened but the reply was lost: events stay, a retry delivers once more, duplicate counts as committed", async () => {
    let attempt = 0
    const delivered: string[] = []
    const {store, service} = await pairedService((_url, init) => {
      const events = JSON.parse(String(init.body)).events as LearningEvent[]
      attempt++
      for (const e of events) delivered.push(e.eventId)
      if (attempt === 1) return new Error("socket hang up after commit")
      return committed(events, "duplicate")
    })
    await service.enqueue(userKey, [event(0)])
    const first = await service.drain(userKey)
    expect(first.outcome).toBe("retry_later")
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(1)

    clockMs += 10 * 60_000
    const second = await service.drain(userKey)
    expect(second).toMatchObject({delivered: 1, remaining: 0})
    expect(delivered).toEqual([event(0).eventId, event(0).eventId])
  })

  test("transient failures back off instead of hammering, then recover", async () => {
    let calls = 0
    const {service} = await pairedService((_url, init) => {
      calls++
      return calls <= 2 ? {status: 503} : committed(JSON.parse(String(init.body)).events)
    })
    await service.enqueue(userKey, [event(0)])
    expect((await service.drain(userKey)).outcome).toBe("retry_later")
    expect((await service.drain(userKey)).outcome).toBe("retry_later")
    expect(calls).toBe(1)
    clockMs += 60_000
    expect((await service.drain(userKey)).outcome).toBe("retry_later")
    expect(calls).toBe(2)
    clockMs += 10 * 60_000
    expect((await service.drain(userKey)).outcome).toBe("delivered")
  })

  test("a conflict or rejection is quarantined, not retried forever", async () => {
    const {store, service} = await pairedService((_url, init) => {
      const events = JSON.parse(String(init.body)).events as LearningEvent[]
      return {
        status: 200,
        body: {
          schemaVersion: 1,
          results: events.map((e) => ({eventId: e.eventId, outcome: "conflict", reason: "changed"})),
        },
      }
    })
    await service.enqueue(userKey, [event(0)])
    const result = await service.drain(userKey)
    expect(result.quarantined).toBe(1)
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(0)
    expect(store.keysUnder(`learning/quarantine/${userKey}/`)).toHaveLength(1)
  })

  test("an event for a source the learner deleted is dropped, not retried and not kept (A18)", async () => {
    const {store, service} = await pairedService((_url, init) => {
      const events = JSON.parse(String(init.body)).events as LearningEvent[]
      return {
        status: 200,
        body: {schemaVersion: 1, results: events.map((e) => ({eventId: e.eventId, outcome: "deleted"}))},
      }
    })
    await service.enqueue(userKey, [event(0)])
    const result = await service.drain(userKey)
    expect(result).toMatchObject({delivered: 0, quarantined: 0, remaining: 0})
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(0)
    expect(store.keysUnder(`learning/quarantine/${userKey}/`)).toHaveLength(0)
  })

  test("a revoked connection stops delivery and purges queued transport data", async () => {
    const {store, service} = await pairedService(() => ({status: 403, body: {error: "connection_revoked"}}))
    await service.enqueue(userKey, [event(0), event(1)])
    expect((await service.drain(userKey)).outcome).toBe("revoked")
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(0)
    const status = await service.status(identity)
    expect(status.connected).toBe(false)
    expect((await service.drain(userKey)).outcome).toBe("not_connected")
  })

  test("a rejected credential asks for re-pairing and keeps the events", async () => {
    const {store, service} = await pairedService(() => ({status: 401}))
    await service.enqueue(userKey, [event(0)])
    expect((await service.drain(userKey)).outcome).toBe("needs_attention")
    expect(store.keysUnder(`learning/outbox/${userKey}/`)).toHaveLength(1)
    expect((await service.status(identity)).lastError).toContain("Pair again")
  })

  test("events older than the retry window become an explicit gap, never a silent loss", async () => {
    const {store, service} = await pairedService((_url, init) => committed(JSON.parse(String(init.body)).events))
    await service.enqueue(userKey, [event(0), event(1)])
    clockMs += RETRY_WINDOW_MS + 60_000
    await service.enqueue(userKey, [event(5, {capturedAt: new Date(clockMs).toISOString()})])
    const result = await service.drain(userKey)
    expect(result.expired).toBe(2)
    expect(result.delivered).toBe(1)
    expect(store.keysUnder(`learning/gaps/${userKey}/`)).toHaveLength(2)
    clockMs = Date.parse("2026-10-11T07:10:00.000Z")
  })

  test("unreadable outbox objects are quarantined and do not block good ones", async () => {
    const {store, service} = await pairedService((_url, init) => committed(JSON.parse(String(init.body)).events))
    await service.enqueue(userKey, [event(1)])
    store.objects.set(`learning/outbox/${userKey}/0000000000000000-000000000-corrupt.json`, "{not json")
    const result = await service.drain(userKey)
    expect(result).toMatchObject({delivered: 1, quarantined: 1})
  })

  test("restarting the service keeps queued events and resumes delivery", async () => {
    const store = new MapStore()
    const down = fakeMandarin((url) => (url.endsWith("/pairing/redeem") ? pairedReply : new Error("offline")))
    const first = new LearningService(store, config, {fetch: down.impl, now: () => clockMs, random: () => 0.5})
    await first.pair(identity, "mps_" + "a".repeat(32))
    await first.enqueue(userKey, [event(0), event(1)])
    expect((await first.drain(userKey)).outcome).toBe("retry_later")

    // A new process reads the same bucket: nothing in memory survives, the events do.
    const up = fakeMandarin((_url, init) => committed(JSON.parse(String(init.body)).events))
    const second = new LearningService(store, config, {fetch: up.impl, now: () => clockMs, random: () => 0.5})
    expect((await second.status(identity)).pendingServerEvents).toBe(2)
    expect(await second.drain(userKey)).toMatchObject({delivered: 2, remaining: 0})
  })
})
