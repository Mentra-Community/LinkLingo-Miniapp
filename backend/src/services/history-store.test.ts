import {describe, expect, test} from "bun:test"

import {HistoryStore, utcDay, type HistoryEvent} from "./history-store"
import {ObjectTape, type ObjectStore} from "./tape-store"

const DAY = 86_400_000
const HOUR = 3_600_000

class MapStore implements ObjectStore {
  readonly objects = new Map<string, string>()
  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body)
  }
  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix))
  }
  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key)
  }
}

const gloss = (at: number, word = "博物馆"): HistoryEvent => ({
  kind: "gloss",
  at,
  word,
  translation: "museum",
  in: "zh",
  out: "en",
})

describe("HistoryStore", () => {
  test("a new pod reads what the evicted one flushed, and its own unflushed events", async () => {
    const objects = new MapStore()
    const now = Date.now()
    const first = new HistoryStore(objects, "pod-a")
    first.record("u1", gloss(now - 2 * HOUR))
    await first.flush()

    const second = new HistoryStore(objects, "pod-b")
    second.record("u1", gloss(now - HOUR, "参观"))
    const events = await second.events("u1", now - DAY, now, now)
    expect(events.map((e) => (e.kind === "gloss" ? e.word : e.kind))).toEqual(["博物馆", "参观"])
  })

  test("pods write separate objects, so two flushes never overwrite each other", async () => {
    const objects = new MapStore()
    const now = Date.now()
    const a = new HistoryStore(objects, "pod-a")
    const b = new HistoryStore(objects, "pod-b")
    a.record("u1", gloss(now))
    b.record("u1", gloss(now, "参观"))
    await Promise.all([a.flush(), b.flush()])
    expect([...objects.objects.keys()].sort()).toEqual([
      `history/u1/${utcDay(now)}/pod-a.json`,
      `history/u1/${utcDay(now)}/pod-b.json`,
    ])
    expect(await new HistoryStore(objects, "pod-c").events("u1", now - HOUR, now + HOUR, now)).toHaveLength(2)
  })

  test("users only ever see their own ledger", async () => {
    const store = new HistoryStore(new MapStore(), "pod-a")
    const now = Date.now()
    store.record("u1", gloss(now))
    store.record("u2", gloss(now, "参观"))
    await store.flush()
    const mine = await store.events("u1", now - HOUR, now + HOUR, now)
    expect(mine).toHaveLength(1)
  })

  test("heard speech is an hourly count, never text", async () => {
    const store = new HistoryStore(null, "pod-a")
    const base = Math.floor(Date.now() / HOUR) * HOUR
    store.countHeard("u1", base + 1_000)
    store.countHeard("u1", base + 2_000)
    store.countHeard("u1", base + HOUR + 1_000)
    const events = await store.events("u1", base - HOUR, base + 2 * HOUR, base)
    expect(events).toEqual([
      {kind: "heard", at: base, count: 2},
      {kind: "heard", at: base + HOUR, count: 1},
    ])
  })

  test("drops days past 90, and the 24h tape pruner leaves history alone", async () => {
    const objects = new MapStore()
    const now = Date.UTC(2026, 9, 6, 12)
    const store = new HistoryStore(objects, "pod-a")
    store.record("u1", gloss(now - 91 * DAY))
    store.record("u1", gloss(now - 89 * DAY))
    store.record("u1", gloss(now - 2 * DAY))
    await store.flush()
    await new ObjectTape(objects, 24 * HOUR).prune(now)
    expect(objects.objects.size).toBe(3)
    expect(await store.prune(now)).toBe(1)
    expect(objects.objects.size).toBe(2)
  })

  test("an old day is compacted into one object without double counting", async () => {
    const objects = new MapStore()
    const now = Date.now()
    const day = now - 5 * DAY
    for (const pod of ["a", "b", "c"]) {
      const s = new HistoryStore(objects, pod)
      s.record("u1", gloss(day))
      await s.flush()
    }
    const reader = new HistoryStore(objects, "reader")
    expect(await reader.events("u1", day - HOUR, day + HOUR, now)).toHaveLength(3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect([...objects.objects.keys()]).toEqual([`history/u1/${utcDay(day)}/compact.json`])
    expect(await new HistoryStore(objects, "later").events("u1", day - HOUR, day + HOUR, now)).toHaveLength(3)
  })
})
