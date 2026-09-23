import {describe, expect, test} from "bun:test"

import {ReviewLog, type ReviewEntryInput} from "./review-log"
import {ObjectTape, mergeById, tapeKey, tapeKeyAt, type ObjectStore} from "./tape-store"

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

function gloss(totalMs: number): ReviewEntryInput {
  return {
    op: "gloss",
    model: "test",
    promptVersion: "p",
    inputLanguage: "zh",
    outputLanguage: "en",
    proficiency: 33,
    knownRank: 1000,
    context: "护照",
    outcome: "words",
    accepted: [],
    rejected: [],
    totalMs,
  }
}

describe("tape keys", () => {
  test("round-trips the timestamp and ignores expired rows by key alone", () => {
    const key = tapeKey("transcript", 1_700_000_000_000, "m1-t2")
    expect(key).toBe("v1/transcript/0001700000000000/m1-t2.json")
    expect(tapeKeyAt(key)).toBe(1_700_000_000_000)
    expect(tapeKeyAt("v1/nope")).toBeNull()
  })
})

describe("ObjectTape", () => {
  test("reloads a row after the memory ring is gone, and drops it after 24h", async () => {
    const store = new MapStore()
    const tape = new ObjectTape(store, 24 * HOUR)
    const now = 100 * HOUR
    await tape.put("transcript", {id: "keep", at: now - HOUR, user: "ab"})
    await tape.put("transcript", {id: "drop", at: now - 25 * HOUR})
    await tape.put("review", {id: "g1", at: now, user: "ab"})

    const fresh = new ObjectTape(store, 24 * HOUR)
    const loaded = await fresh.loadAll(now)
    expect(loaded.transcript.map((e) => e.id)).toEqual(["keep"])
    expect(loaded.review.map((e) => e.id)).toEqual(["g1"])

    expect(await fresh.prune(now)).toBe(1)
    expect((await fresh.load("transcript", now)).map((e) => e.id)).toEqual(["keep"])
    expect(store.objects.size).toBe(2)
  })

  test("a later write of the same id replaces the body", async () => {
    const store = new MapStore()
    const tape = new ObjectTape(store, 24 * HOUR)
    await tape.put("review", {id: "g1", at: 5_000})
    await tape.put("review", {id: "g1", at: 5_000, user: "late"})
    const [row] = await tape.load("review", 6_000)
    expect(row.user).toBe("late")
    expect(store.objects.size).toBe(1)
  })
})

describe("memory ring reload", () => {
  test("loadFrom merges by id and a new log can serve the saved rows", () => {
    const now = Date.now()
    const first = new ReviewLog(24 * HOUR, 100, null)
    const saved = first.record(gloss(10), now - 1_000)
    const second = new ReviewLog(24 * HOUR, 100, null)
    second.loadFrom([saved])
    expect(second.list({}, now).map((e) => e.id)).toEqual([saved.id])
    expect(mergeById([{id: "a", at: 2}], [{id: "a", at: 2, user: "x"}, {id: "b", at: 1}])).toEqual([
      {id: "b", at: 1},
      {id: "a", at: 2, user: "x"},
    ])
  })
})
