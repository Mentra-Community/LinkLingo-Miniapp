import {describe, expect, test} from "bun:test"

import type {LearningEvent} from "../shared/mandarin-contract"
import {
  ID_PATTERN,
  LearningCapture,
  captureModeFor,
  computeBackoffMs,
  type CaptureStorage,
  type EnqueueInput,
  type LearningCaptureOptions,
  type SendResult,
} from "./learningCapture"

const INDEX_KEY = "linklingo:learn:index"
const chunkKey = (id: number) => `linklingo:learn:c:${id}`
const qKey = (n: number) => `linklingo:learn:q:${n}`

/** In-memory session.storage with variable latency so interleavings are actually exercised. */
class FakeStorage implements CaptureStorage {
  data = new Map<string, string>()
  setLog: string[] = []
  /** Throw from `set` when this returns true. */
  failSet: ((key: string) => boolean) | null = null
  private calls = 0

  private async tick(): Promise<void> {
    this.calls++
    for (let i = 0; i < this.calls % 4; i++) await Promise.resolve()
  }
  async get(key: string) {
    await this.tick()
    return this.data.get(key) ?? null
  }
  async set(key: string, value: string) {
    await this.tick()
    if (this.failSet?.(key)) throw new Error("disk full")
    this.data.set(key, value)
    this.setLog.push(key)
  }
  async delete(key: string) {
    await this.tick()
    this.data.delete(key)
  }
  async keys() {
    return [...this.data.keys()]
  }
}

class FakeTimers {
  tasks: Array<{id: number; fn: () => void; ms: number}> = []
  private next = 1
  set(fn: () => void, ms: number) {
    const id = this.next++
    this.tasks.push({id, fn, ms})
    return id
  }
  clear(handle: unknown) {
    this.tasks = this.tasks.filter((t) => t.id !== handle)
  }
  last() {
    return this.tasks[this.tasks.length - 1]
  }
  /** Runs and removes every pending timer. */
  async fireAll() {
    const due = this.tasks
    this.tasks = []
    for (const t of due) t.fn()
    await settle()
  }
}

async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

const ok = (
  accepted: string[],
  rejected: Array<{eventId: string; reason: string; permanent: boolean}> = [],
): SendResult => ({
  kind: "ok",
  accepted,
  rejected,
})

function text(n: number): EnqueueInput {
  return {
    text: `今天天气很好 ${n}`,
    language: "zh-CN",
    inputLanguage: "zh",
    outputLanguage: "en",
    mode: "gloss",
    disposition: "skipped_no_candidates",
    utteranceId: `utt-${n}`,
  }
}

interface Harness {
  cap: LearningCapture
  storage: FakeStorage
  timers: FakeTimers
  sends: LearningEvent[][]
  clock: {now: number}
  /** Next results returned by `send`; when empty, everything in the batch is accepted. */
  results: Array<SendResult | Error | ((events: LearningEvent[]) => SendResult)>
  restart(overrides?: Partial<LearningCaptureOptions>): Promise<LearningCapture>
}

let idCounter = 0

async function make(
  overrides: Partial<LearningCaptureOptions> = {},
  opts: {enabled?: boolean; connected?: boolean; storage?: FakeStorage; clock?: {now: number}} = {},
): Promise<Harness> {
  const storage = opts.storage ?? new FakeStorage()
  const timers = new FakeTimers()
  const clock = opts.clock ?? {now: Date.UTC(2026, 9, 11, 8, 0, 0)}
  const sends: LearningEvent[][] = []
  const results: Harness["results"] = []
  const build = (extra: Partial<LearningCaptureOptions>) =>
    new LearningCapture({
      storage,
      send: async (events) => {
        sends.push(events)
        const next = results.shift()
        if (next instanceof Error) throw next
        if (typeof next === "function") return next(events)
        return next ?? ok(events.map((e) => e.eventId))
      },
      clientVersion: "1.0.99",
      clientBuildId: "testbuild",
      now: () => clock.now,
      randomId: () => `id_${String(++idCounter).padStart(10, "0")}`,
      random: () => 1,
      timers,
      ...overrides,
      ...extra,
    })
  const cap = build({})
  const harness: Harness = {
    cap,
    storage,
    timers,
    sends,
    clock,
    results,
    restart: async (extra = {}) => {
      cap.dispose()
      const next = build(extra)
      harness.cap = next
      await next.init()
      next.setEnabled(opts.enabled !== false)
      next.setListening(true)
      return next
    },
  }
  await cap.init()
  cap.setEnabled(opts.enabled !== false)
  cap.setConnected(opts.connected !== false)
  cap.setListening(true)
  cap.startSession()
  await settle()
  return harness
}

function allSent(h: Harness): LearningEvent[] {
  return h.sends.flat()
}

describe("enqueue durability", () => {
  test("the event is in storage before any send is attempted", async () => {
    const h = await make()
    let persistedAtSend: boolean[] = []
    const cap = new LearningCapture({
      storage: h.storage,
      clientVersion: "1",
      clientBuildId: "b",
      timers: h.timers,
      send: async (events) => {
        const bodies = [...h.storage.data.entries()].filter(([k]) => k.includes(":c:")).map(([, v]) => v)
        persistedAtSend = events.map((e) => bodies.some((b) => b.includes(e.eventId)))
        return ok(events.map((e) => e.eventId))
      },
    })
    await cap.init()
    cap.setEnabled(true)
    cap.setConnected(true)
    const result = await cap.enqueue(text(1))
    expect(result.status).toBe("queued")
    await cap.drain()
    expect(persistedAtSend).toEqual([true])
    cap.dispose()
  })

  test("resolves only after the storage write, and reports a failed write instead of pretending", async () => {
    const h = await make()
    h.storage.failSet = (key) => key.includes(":c:")
    const result = await h.cap.enqueue(text(1))
    expect(result.status).toBe("error")
    expect(h.cap.status().pending).toBe(0)
    expect(h.cap.status().state).toBe("needs_attention")
    expect(h.cap.status().lastError).toContain("storage")
    h.storage.failSet = null
    expect((await h.cap.enqueue(text(2))).status).toBe("queued")
    expect(h.cap.status().pending).toBe(1)
    expect(h.cap.status().state).not.toBe("needs_attention")
  })

  test("builds a complete contract event and leaves the text untouched", async () => {
    const h = await make({timezone: "Asia/Shanghai"})
    const result = await h.cap.enqueue({...text(1), text: "  你好，我想 order 一杯咖啡  "})
    expect(result.status).toBe("queued")
    await h.cap.drain()
    const e = allSent(h)[0]!
    expect(e.schemaVersion).toBe(1)
    expect(e.source).toBe("linklingo")
    expect(e.speakerAttribution).toBe("unknown")
    expect(e.text).toBe("  你好，我想 order 一杯咖啡  ")
    expect(e.capturedAt).toBe(new Date(h.clock.now).toISOString())
    expect(e.capturedAt).toMatch(/Z$/)
    expect(e.timezone).toBe("Asia/Shanghai")
    expect(e.clientVersion).toBe("1.0.99")
    expect(e.clientBuildId).toBe("testbuild")
    expect(e.detectedLanguage).toBe("zh-CN")
    expect(e.utteranceId).toBe("utt-1")
    expect(e.eventId).toMatch(ID_PATTERN)
    expect(e.sourceSessionId).toMatch(ID_PATTERN)
    if (result.status === "queued") expect(e.eventId).toBe(result.eventId)
  })

  test("rejects empty and whitespace-only text without storing anything", async () => {
    const h = await make()
    expect((await h.cap.enqueue({...text(1), text: ""})).status).toBe("rejected")
    expect((await h.cap.enqueue({...text(1), text: " \n "})).status).toBe("rejected")
    expect(h.cap.status().pending).toBe(0)
    expect(h.storage.setLog.filter((k) => k.includes(":c:"))).toEqual([])
  })

  test("an unusable randomId falls back to a valid id", async () => {
    const h = await make({randomId: () => "bad id!"})
    const result = await h.cap.enqueue(text(1))
    expect(result.status).toBe("queued")
    if (result.status === "queued") expect(result.eventId).toMatch(ID_PATTERN)
  })

  test("concurrent enqueues all persist, in call order, across chunk boundaries", async () => {
    const h = await make({chunkMaxEvents: 4})
    const results = await Promise.all(Array.from({length: 25}, (_, i) => h.cap.enqueue(text(i + 1))))
    expect(results.every((r) => r.status === "queued")).toBe(true)
    expect(h.cap.status().pending).toBe(25)

    const restarted = await h.restart({chunkMaxEvents: 4})
    expect(restarted.status().pending).toBe(25)
    await restarted.drain({force: true})
    const sent = allSent(h)
    expect(sent.map((e) => e.sequence)).toEqual(Array.from({length: 25}, (_, i) => i + 1))
    expect(new Set(sent.map((e) => e.eventId)).size).toBe(25)
    expect(sent.map((e) => e.text)).toEqual(Array.from({length: 25}, (_, i) => text(i + 1).text))
  })

  test("enqueue never waits on a slow send", async () => {
    const h = await make()
    let release!: (r: SendResult) => void
    let inFlight: LearningEvent[] = []
    let calls = 0
    const slow = new LearningCapture({
      storage: h.storage,
      clientVersion: "1",
      clientBuildId: "b",
      timers: h.timers,
      send: (events) => {
        calls++
        if (calls > 1) return Promise.resolve<SendResult>({kind: "transient", error: "stop"})
        inFlight = events
        return new Promise<SendResult>((resolve) => {
          release = resolve
        })
      },
    })
    await slow.init()
    slow.setEnabled(true)
    slow.setConnected(true)
    await slow.enqueue(text(1))
    const draining = slow.drain()
    await settle()
    expect(inFlight).toHaveLength(1)
    // Enqueue while the send is hanging: it resolves without waiting for the network.
    const second = await slow.enqueue(text(2))
    expect(second.status).toBe("queued")
    release({kind: "ok", accepted: inFlight.map((e) => e.eventId), rejected: []})
    await draining
    // Only the acknowledged event left the queue; the one enqueued mid-flight remains.
    expect(slow.status().pending).toBe(1)
    slow.dispose()
  })
})

describe("restart recovery", () => {
  test("a new instance over the same storage restores queue, gaps, and quarantine", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    await h.cap.enqueue(text(2))
    await h.cap.enqueue(text(3))
    const before = h.cap.status()
    const firstSession = allIds(h)

    const next = await h.restart()
    const after = next.status()
    expect(after.pending).toBe(3)
    expect(after.pendingBytes).toBe(before.pendingBytes)
    expect(after.quarantined).toBe(before.quarantined)
    expect(after.gaps).toEqual(before.gaps)

    await next.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([1, 2, 3])
    expect(allSent(h).map((e) => e.eventId)).toEqual(firstSession)
    expect(next.status().pending).toBe(0)
    expect(next.status().lastAcceptedAt).toBe(h.clock.now)
  })

  test("sequence is monotonic within a session and sourceSessionId changes across runs", async () => {
    const h = await make()
    const a1 = await h.cap.enqueue(text(1))
    const a2 = await h.cap.enqueue(text(2))
    const a3 = await h.cap.enqueue(text(3))
    if (a1.status !== "queued" || a2.status !== "queued" || a3.status !== "queued") throw new Error("not queued")
    expect([a1.sequence, a2.sequence, a3.sequence]).toEqual([1, 2, 3])
    expect(a1.sourceSessionId).toBe(a3.sourceSessionId)

    const next = await h.restart()
    next.setConnected(true)
    const sessionB = next.startSession()
    const b1 = await next.enqueue(text(4))
    if (b1.status !== "queued") throw new Error("not queued")
    expect(b1.sourceSessionId).toBe(sessionB)
    expect(sessionB).not.toBe(a1.sourceSessionId)
    expect(sessionB).toMatch(ID_PATTERN)
    expect(b1.sequence).toBe(1)

    // A restart without an explicit startSession still must not reuse the old run's id.
    const third = await h.restart()
    third.setConnected(true)
    const c1 = await third.enqueue(text(5))
    if (c1.status !== "queued") throw new Error("not queued")
    expect(c1.sourceSessionId).not.toBe(a1.sourceSessionId)
    expect(c1.sourceSessionId).not.toBe(sessionB)
  })

  test("a connection state saved before shutdown is restored, so capture works before the first poll", async () => {
    const h = await make()
    const next = await h.restart()
    expect(next.status().state).not.toBe("not_connected")
    expect((await next.enqueue(text(1))).status).toBe("queued")
  })

  test("a chunk written but never indexed (crash between the two writes) is adopted, not lost", async () => {
    const h = await make()
    h.storage.failSet = (key) => key === INDEX_KEY
    const result = await h.cap.enqueue(text(1))
    expect(result.status).toBe("error")
    h.storage.failSet = null
    const next = await h.restart()
    expect(next.status().pending).toBe(1)
    await next.drain({force: true})
    expect(allSent(h)).toHaveLength(1)
  })

  test("a stale index after a crash during an ack resurrects events instead of losing them", async () => {
    const h = await make({chunkMaxEvents: 10})
    for (let i = 1; i <= 3; i++) await h.cap.enqueue(text(i))
    // Simulate: index says 1 event, but the chunk body still has 3 (remove writes index first).
    const idx = JSON.parse(h.storage.data.get(INDEX_KEY)!)
    idx.chunks[0][1] = 1
    h.storage.data.set(INDEX_KEY, JSON.stringify(idx))
    const next = await h.restart({chunkMaxEvents: 10})
    expect(next.status().pending).toBe(3)
  })
})

function allIds(h: Harness): string[] {
  const out: string[] = []
  for (const [key, value] of h.storage.data) {
    if (!key.includes(":c:")) continue
    out.push(...(JSON.parse(value).events as LearningEvent[]).map((e) => e.eventId))
  }
  return out
}

describe("delivery and acknowledgement", () => {
  test("removes only the acknowledged ids", async () => {
    const h = await make()
    for (let i = 1; i <= 5; i++) await h.cap.enqueue(text(i))
    const ids = allIds(h)
    h.results.push(ok([ids[0]!, ids[2]!]), {kind: "transient", error: "stop here"})
    await h.cap.drain({force: true})
    expect(h.cap.status().pending).toBe(3)
    // The second send (the transient stop) shows exactly who is left.
    expect(h.sends[1]!.map((e) => e.eventId)).toEqual([ids[1], ids[3], ids[4]])
    expect(allIds(h)).toEqual([ids[1], ids[3], ids[4]])
  })

  test("a retry after a lost reply resends the SAME eventIds", async () => {
    const h = await make()
    for (let i = 1; i <= 3; i++) await h.cap.enqueue(text(i))
    // The server stored the batch but the reply never arrived.
    h.results.push(new Error("network lost the reply"))
    await h.cap.drain({force: true})
    expect(h.cap.status().pending).toBe(3)
    expect(h.cap.status().lastError).toContain("lost the reply")

    await h.cap.drain({force: true})
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]!.map((e) => e.eventId)).toEqual(h.sends[0]!.map((e) => e.eventId))
    expect(h.cap.status().pending).toBe(0)
    expect(h.cap.status().lastError).toBeNull()
  })

  test("a permanently rejected event is quarantined with its reason; the rest are delivered", async () => {
    const h = await make()
    for (let i = 1; i <= 3; i++) await h.cap.enqueue(text(i))
    const ids = allIds(h)
    h.results.push(ok([ids[0]!, ids[2]!], [{eventId: ids[1]!, reason: "text too long", permanent: true}]))
    await h.cap.drain({force: true})
    const status = h.cap.status()
    expect(status.pending).toBe(0)
    expect(status.quarantined).toBe(1)
    const record = JSON.parse(h.storage.data.get(qKey(1))!)
    expect(record.kind).toBe("event")
    expect(record.reason).toBe("text too long")
    expect(record.event.eventId).toBe(ids[1])
    expect(h.sends).toHaveLength(1) // not retried forever
  })

  test("a non-permanent rejection stays queued and backs off", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    const [id] = allIds(h)
    h.results.push(ok([], [{eventId: id!, reason: "busy", permanent: false}]))
    await h.cap.drain({force: true})
    expect(h.cap.status().pending).toBe(1)
    expect(h.cap.status().state).toBe("waiting_to_send")
    expect(h.cap.status().quarantined).toBe(0)
  })

  test("batches are bounded by event count and by bytes, oldest first", async () => {
    const h = await make()
    for (let i = 1; i <= 120; i++) await h.cap.enqueue(text(i))
    await h.cap.drain({force: true})
    expect(h.sends.map((b) => b.length)).toEqual([50, 50, 20])
    expect(allSent(h).map((e) => e.sequence)).toEqual(Array.from({length: 120}, (_, i) => i + 1))

    const small = await make({batchMaxBytes: 1200})
    for (let i = 1; i <= 8; i++) await small.cap.enqueue(text(i))
    await small.cap.drain({force: true})
    expect(small.sends.length).toBeGreaterThan(1)
    for (const batch of small.sends) {
      const bytes = new TextEncoder().encode(JSON.stringify(batch)).length
      expect(batch.length === 1 || bytes <= 1200 + 2 * batch.length).toBe(true)
    }
    expect(allSent(small).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  test("a batch refused outright is bisected until the offending event is quarantined", async () => {
    const h = await make({batchMaxEvents: 8})
    for (let i = 1; i <= 6; i++) await h.cap.enqueue(text(i))
    const poison = allIds(h)[3]!
    const refuse = (events: LearningEvent[]): SendResult =>
      events.some((e) => e.eventId === poison)
        ? {kind: "batch_rejected", status: 400}
        : ok(events.map((e) => e.eventId))
    for (let i = 0; i < 40; i++) h.results.push(refuse)
    await h.cap.drain({force: true})
    const status = h.cap.status()
    expect(status.pending).toBe(0)
    expect(status.quarantined).toBe(1)
    expect(JSON.parse(h.storage.data.get(qKey(1))!).reason).toBe("http_400")
    const delivered = new Set(h.sends.flat().map((e) => e.eventId))
    expect(delivered.has(poison)).toBe(true) // it was offered, then isolated
  })

  test("a server that refuses everything stops and asks for attention instead of emptying the queue", async () => {
    const h = await make({batchMaxEvents: 1})
    for (let i = 1; i <= 12; i++) await h.cap.enqueue(text(i))
    for (let i = 0; i < 40; i++) h.results.push({kind: "batch_rejected", status: 400})
    await h.cap.drain({force: true})
    expect(h.cap.status().state).toBe("needs_attention")
    expect(h.cap.status().lastError).toBe("server_rejecting")
    expect(h.cap.status().pending + h.cap.status().quarantined).toBe(12)
    expect(h.cap.status().pending).toBeGreaterThanOrEqual(6)
  })
})

describe("backoff", () => {
  test("exponential with equal jitter, capped near 5 minutes", () => {
    const full = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => computeBackoffMs(n, 2000, 300_000, () => 1))
    expect(full).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000])
    const half = [1, 2, 3, 10].map((n) => computeBackoffMs(n, 2000, 300_000, () => 0))
    expect(half).toEqual([1000, 2000, 4000, 150000])
    for (let n = 1; n < 15; n++) {
      const v = computeBackoffMs(n, 2000, 300_000, Math.random)
      expect(v).toBeLessThanOrEqual(300_000)
      expect(v).toBeGreaterThanOrEqual(1000)
    }
  })

  test("consecutive transient failures schedule growing retries and respect the wait", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    h.timers.tasks = []
    for (let i = 0; i < 4; i++) h.results.push({kind: "transient", error: "HTTP 503"})

    await h.cap.drain({force: true})
    expect(h.timers.last()!.ms).toBe(2000)
    // Within the backoff window an ordinary drain must not send.
    await h.cap.drain()
    expect(h.sends).toHaveLength(1)

    h.clock.now += 2000
    await h.cap.drain()
    expect(h.sends).toHaveLength(2)
    expect(h.timers.last()!.ms).toBe(4000)

    h.clock.now += 4000
    await h.cap.drain()
    expect(h.timers.last()!.ms).toBe(8000)
    expect(h.cap.status().state).toBe("waiting_to_send")
    expect(h.cap.status().lastError).toBe("HTTP 503")

    h.clock.now += 8000
    await h.cap.drain()
    expect(h.timers.last()!.ms).toBe(16000)

    // Recovery clears the error and the streak.
    h.clock.now += 16000
    await h.cap.drain()
    expect(h.cap.status().pending).toBe(0)
    expect(h.cap.status().lastError).toBeNull()
    expect(h.cap.status().state).toBe("listening")
  })

  test("the scheduled retry timer drives the next attempt", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    h.results.push({kind: "transient", error: "offline"})
    await h.cap.drain({force: true})
    h.clock.now += 5000
    await h.timers.fireAll()
    expect(h.sends).toHaveLength(2)
    expect(h.cap.status().pending).toBe(0)
  })
})

describe("needs attention", () => {
  test("401 keeps everything, stops draining, and reports needs_attention", async () => {
    const h = await make()
    for (let i = 1; i <= 3; i++) await h.cap.enqueue(text(i))
    h.results.push({kind: "auth", error: "HTTP 401"})
    await h.cap.drain({force: true})
    expect(h.cap.status().state).toBe("needs_attention")
    expect(h.cap.status().pending).toBe(3)
    expect(h.cap.status().lastError).toBe("auth_failed")

    await h.cap.drain() // does not hammer the server
    await h.cap.drain({force: true})
    expect(h.sends).toHaveLength(1)

    // New captures still persist while delivery is stuck.
    expect((await h.cap.enqueue(text(4))).status).toBe("queued")
    expect(h.cap.status().pending).toBe(4)

    await h.cap.retryNow() // e.g. a refreshed token or the app coming to the foreground
    expect(h.cap.status().pending).toBe(0)
    expect(h.cap.status().state).toBe("listening")
    expect(h.sends[1]!.map((e) => e.sequence)).toEqual([1, 2, 3, 4])
  })

  test("not_connected from the server keeps the queue and needs attention until reconnected", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    h.results.push({kind: "not_connected"})
    await h.cap.drain({force: true})
    expect(h.cap.status().state).toBe("needs_attention")
    expect(h.cap.status().lastError).toBe("not_connected")
    expect(h.cap.status().pending).toBe(1)

    // The status poll flips to disconnected, then back once the learner pairs.
    h.cap.setConnected(false)
    expect(h.cap.status().state).toBe("not_connected")
    h.cap.setConnected(true)
    await h.timers.fireAll()
    expect(h.cap.status().pending).toBe(0)
  })

  test("while the backend reports no connection nothing new is stored and nothing is sent", async () => {
    const h = await make({}, {connected: false})
    expect((await h.cap.enqueue(text(1))).status).toBe("not_connected")
    expect(h.cap.status().state).toBe("not_connected")
    expect(h.cap.status().pending).toBe(0)
    await h.cap.drain({force: true})
    expect(h.sends).toHaveLength(0)
  })

  test("an explicit save is kept on the phone until Mandarin is connected", async () => {
    const h = await make({}, {connected: false})
    const result = await h.cap.enqueue({
      ...text(1),
      text: "I need to reschedule the meeting.",
      explicit: true,
      mode: "reverse",
      disposition: "save_for_later",
      contextBefore: "Can we talk about Thursday?",
    })
    expect(result.status).toBe("queued")
    expect(h.cap.status().pending).toBe(1)
    h.cap.setConnected(true)
    await h.cap.drain({force: true})
    expect(allSent(h)[0]).toMatchObject({
      text: "I need to reschedule the meeting.",
      contextBefore: "Can we talk about Thursday?",
      disposition: "save_for_later",
    })
  })
})

describe("pause and status", () => {
  test("pausing stops new enqueues but the backlog still drains", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    await h.cap.enqueue(text(2))
    h.cap.setEnabled(false)
    expect((await h.cap.enqueue(text(3))).status).toBe("paused")
    expect(h.cap.status().pending).toBe(2)
    expect(h.cap.status().state).toBe("paused")
    await h.cap.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([1, 2])
    expect(h.cap.status().pending).toBe(0)
    expect(h.cap.status().state).toBe("paused")
  })

  test("an explicit save still queues while passive capture is paused", async () => {
    const h = await make()
    h.cap.setEnabled(false)
    const result = await h.cap.enqueue({
      ...text(1),
      text: "I need to reschedule the meeting.",
      explicit: true,
      mode: "reverse",
      disposition: "save_for_later",
    })
    expect(result.status).toBe("queued")
    await h.cap.drain({force: true})
    expect(allSent(h)[0]).toMatchObject({
      text: "I need to reschedule the meeting.",
      disposition: "save_for_later",
    })
  })

  test("listening requires enabled AND an active subscription; it is not delivery evidence", async () => {
    const h = await make()
    expect(h.cap.status().state).toBe("listening")
    h.cap.setListening(false)
    expect(h.cap.status().state).toBe("paused")
    h.cap.setListening(true)
    h.cap.setEnabled(false)
    expect(h.cap.status().state).toBe("paused")
    h.cap.setEnabled(true)
    expect(h.cap.status().state).toBe("listening")
    // Listening with a failing server: undelivered backlog is called out.
    await h.cap.enqueue(text(1))
    h.results.push({kind: "transient", error: "HTTP 500"})
    await h.cap.drain({force: true})
    expect(h.cap.status().state).toBe("waiting_to_send")
    expect(h.cap.status().lastAcceptedAt).toBeNull()
  })

  test("notifies listeners when status changes, and a throwing listener is contained", async () => {
    const h = await make()
    let calls = 0
    h.cap.onChange(() => {
      calls++
      throw new Error("listener bug")
    })
    await h.cap.enqueue(text(1))
    h.cap.setListening(false)
    expect(calls).toBeGreaterThan(1)
  })

  test("enqueue after the debounce schedules a drain that delivers without being asked", async () => {
    const h = await make({drainDebounceMs: 1500})
    await h.cap.enqueue(text(1))
    expect(h.timers.last()!.ms).toBe(1500)
    await h.cap.enqueue(text(2)) // throttle: still one pending timer
    expect(h.timers.tasks).toHaveLength(1)
    await h.timers.fireAll()
    expect(allSent(h).map((e) => e.sequence)).toEqual([1, 2])
  })
})

describe("every kind of final is captured", () => {
  test("gloss, translation, reverse and heard modes, each with a disposition", async () => {
    const h = await make()
    const cases: Array<[EnqueueInput["mode"], EnqueueInput["disposition"]]> = [
      ["gloss", "queued_gloss"],
      ["gloss", "skipped_short"],
      ["translation", "translation_mode"],
      ["reverse", "reverse_gloss"],
      ["heard", "heard"],
      ["gloss", "skipped_language"],
      ["gloss", "skipped_no_candidates"],
      ["gloss", "skipped_duplicate"],
      ["gloss", "skipped_cooldown"],
    ]
    for (const [i, [mode, disposition]] of cases.entries()) {
      expect((await h.cap.enqueue({...text(i), mode, disposition})).status).toBe("queued")
    }
    await h.cap.drain({force: true})
    expect(allSent(h).map((e) => [e.mode, e.disposition])).toEqual(cases)
  })

  test("a simple sentence with no rare words is captured exactly like a glossed one", async () => {
    const h = await make()
    await h.cap.enqueue({...text(1), text: "我们去吃饭吧", disposition: "skipped_no_candidates"})
    await h.cap.enqueue({...text(2), text: "That's fine, thanks", language: "en-US", disposition: "skipped_language"})
    await h.cap.drain({force: true})
    expect(allSent(h).map((e) => e.text)).toEqual(["我们去吃饭吧", "That's fine, thanks"])
  })

  test("captureModeFor maps the controller's view to the contract's modes", () => {
    expect(captureModeFor("gloss-captions", "queued_gloss")).toBe("gloss")
    expect(captureModeFor("gloss", "skipped_short")).toBe("gloss")
    expect(captureModeFor("translation", "translation_mode")).toBe("translation")
    expect(captureModeFor("translation", "heard")).toBe("translation")
    expect(captureModeFor("gloss-captions", "reverse_gloss")).toBe("reverse")
    expect(captureModeFor("gloss-captions", "heard")).toBe("heard")
  })
})

describe("bounded queue", () => {
  test("overflow drops the OLDEST events first and records an explicit gap", async () => {
    const probe = await make()
    await probe.cap.enqueue(text(1))
    const size = probe.cap.status().pendingBytes

    const h = await make({maxBytes: size * 3, chunkMaxEvents: 2})
    for (let i = 1; i <= 6; i++) await h.cap.enqueue(text(i))
    const status = h.cap.status()
    expect(status.pending).toBe(3)
    expect(status.pendingBytes).toBeLessThanOrEqual(size * 3)
    expect(status.gaps).toHaveLength(1)
    expect(status.gaps[0]).toMatchObject({reason: "overflow", fromSequence: 1, toSequence: 3, count: 3})
    expect(status.gaps[0]!.fromAt).toBe(new Date(h.clock.now).toISOString())
    expect(status.gaps[0]!.sourceSessionId).toMatch(ID_PATTERN)

    // The gap survives a restart and the survivors are the newest events.
    const next = await h.restart({maxBytes: size * 3, chunkMaxEvents: 2})
    expect(next.status().gaps).toEqual(status.gaps)
    await next.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([4, 5, 6])
    // Delivering the survivors never erases the record of what was lost.
    expect(next.status().gaps).toHaveLength(1)
  })

  test("consecutive overflow drops merge into one contiguous gap; separate sessions stay separate", async () => {
    const probe = await make()
    await probe.cap.enqueue(text(1))
    const size = probe.cap.status().pendingBytes
    const h = await make({maxBytes: size * 2})
    for (let i = 1; i <= 3; i++) await h.cap.enqueue(text(i))
    h.cap.startSession()
    for (let i = 4; i <= 7; i++) await h.cap.enqueue(text(i))
    const gaps = h.cap.status().gaps
    const total = gaps.reduce((n, g) => n + g.count, 0)
    expect(total).toBe(5)
    expect(new Set(gaps.map((g) => g.sourceSessionId)).size).toBe(2)
    expect(gaps[0]).toMatchObject({fromSequence: 1, toSequence: 3})
  })

  test("an event larger than the whole cap is recorded as a gap, never silently dropped", async () => {
    const h = await make({maxBytes: 100})
    const result = await h.cap.enqueue(text(1))
    expect(result.status).toBe("dropped")
    expect(h.cap.status().gaps).toHaveLength(1)
    expect(h.cap.status().pending).toBe(0)
  })

  test("events older than the expiry window are dropped with an 'expired' gap", async () => {
    const h = await make({expiryMs: 7 * 24 * 3600 * 1000})
    await h.cap.enqueue(text(1))
    await h.cap.enqueue(text(2))
    h.clock.now += 8 * 24 * 3600 * 1000
    await h.cap.enqueue(text(3))
    await h.cap.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([3])
    const gaps = h.cap.status().gaps
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({reason: "expired", fromSequence: 1, toSequence: 2, count: 2})
  })

  test("expiry is also applied when the app restarts", async () => {
    const h = await make()
    await h.cap.enqueue(text(1))
    h.clock.now += 8 * 24 * 3600 * 1000
    const next = await h.restart()
    expect(next.status().pending).toBe(0)
    expect(next.status().gaps[0]).toMatchObject({reason: "expired", count: 1})
  })
})

describe("corruption", () => {
  test("an unparseable chunk is quarantined and counted; the rest of the queue keeps working", async () => {
    const h = await make({chunkMaxEvents: 2})
    for (let i = 1; i <= 6; i++) await h.cap.enqueue(text(i))
    h.storage.data.set(chunkKey(2), "{not json")

    const next = await h.restart({chunkMaxEvents: 2})
    await next.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([1, 2, 5, 6])
    const status = next.status()
    expect(status.pending).toBe(0)
    expect(status.quarantined).toBe(2)
    const record = JSON.parse(h.storage.data.get(qKey(1))!)
    expect(record).toMatchObject({kind: "chunk", reason: "chunk_corrupt", chunkId: 2, raw: "{not json", count: 2})
    expect(h.storage.data.has(chunkKey(2))).toBe(false) // not retried forever
  })

  test("a missing chunk body is counted, not ignored", async () => {
    const h = await make({chunkMaxEvents: 2})
    for (let i = 1; i <= 4; i++) await h.cap.enqueue(text(i))
    h.storage.data.delete(chunkKey(1))
    const next = await h.restart({chunkMaxEvents: 2})
    await next.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([3, 4])
    expect(next.status().quarantined).toBe(2)
  })

  test("a malformed event inside a valid chunk is quarantined individually", async () => {
    const h = await make({chunkMaxEvents: 10})
    for (let i = 1; i <= 3; i++) await h.cap.enqueue(text(i))
    const body = JSON.parse(h.storage.data.get(chunkKey(1))!)
    body.events[1] = {eventId: 42}
    h.storage.data.set(chunkKey(1), JSON.stringify(body))
    const next = await h.restart({chunkMaxEvents: 10})
    await next.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([1, 3])
    expect(next.status().quarantined).toBe(1)
  })

  test("a corrupt index is quarantined and the queue is rebuilt from the chunks", async () => {
    const h = await make({chunkMaxEvents: 2})
    for (let i = 1; i <= 5; i++) await h.cap.enqueue(text(i))
    h.storage.data.set(INDEX_KEY, "<<garbage>>")
    const next = await h.restart({chunkMaxEvents: 2})
    expect(next.status().pending).toBe(5)
    expect(next.status().quarantined).toBe(1)
    expect(JSON.parse(h.storage.data.get(qKey(1))!)).toMatchObject({kind: "index", raw: "<<garbage>>"})
    next.setConnected(true) // the connection flag lived in the lost index; the status poll restores it
    await next.drain({force: true})
    expect(allSent(h).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5])
    // New events after recovery use fresh chunk ids and do not clobber anything.
    expect((await next.enqueue(text(6))).status).toBe("queued")
  })

  test("only the newest 50 quarantine records are kept, but every one is counted", async () => {
    const h = await make({batchMaxEvents: 100})
    for (let i = 1; i <= 60; i++) await h.cap.enqueue(text(i))
    const ids = allIds(h)
    h.results.push(
      ok(
        [],
        ids.map((eventId) => ({eventId, reason: "bad", permanent: true})),
      ),
    )
    await h.cap.drain({force: true})
    expect(h.cap.status().quarantined).toBe(60)
    const kept = [...h.storage.data.keys()].filter((k) => k.includes(":q:"))
    expect(kept).toHaveLength(50)
  })
})

describe("storage layout", () => {
  test("the queue is sharded into small chunk keys plus a small index, never one giant value", async () => {
    const h = await make()
    for (let i = 1; i <= 200; i++) await h.cap.enqueue(text(i))
    const keys = [...h.storage.data.keys()]
    const chunks = keys.filter((k) => k.includes(":c:"))
    expect(chunks.length).toBe(4) // 50 events per chunk
    const biggest = Math.max(...chunks.map((k) => h.storage.data.get(k)!.length))
    expect(biggest).toBeLessThan(40 * 1024)
    expect(h.storage.data.get(INDEX_KEY)!.length).toBeLessThan(2 * 1024)
  })

  test("a small queue writes the tail chunk and index only, not the whole queue", async () => {
    const h = await make()
    for (let i = 1; i <= 120; i++) await h.cap.enqueue(text(i))
    const before = h.storage.setLog.length
    await h.cap.enqueue(text(121))
    const writes = h.storage.setLog.slice(before)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe(INDEX_KEY)
  })
})
