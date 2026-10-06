/**
 * The learner's word ledger: what was glossed, what they fell back to, what
 * they flagged, and the daily review. Kept 90 days so the dashboard can show
 * weeks, while the raw transcript tape still expires after 24h. Nothing here
 * holds a transcript; the review keeps only short excerpts.
 *
 * Each pod writes its own object per user per UTC day,
 * `history/<user>/<day>/<pod>.json`, overwriting only that one. Pods never
 * share an object, so an evicted pod and its replacement cannot clobber each
 * other, and a day's events are the union of its objects.
 */

import {randomUUID} from "node:crypto"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {ObjectStore} from "./tape-store"

const log = createLogger("history")

export const HISTORY_RETENTION_DAYS = 90
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** Days this old are complete, so their per-pod objects can be merged into one. */
const COMPACT_AFTER_DAYS = 2

export interface ReviewItem {
  /** What was heard, at most 20 characters; may be another speaker. */
  said: string
  better: string
  rule: string
  confidence: "high" | "medium" | "low"
}

export type HistoryEvent =
  | {kind: "gloss" | "reverse"; at: number; word: string; translation: string; in: string; out: string}
  | {kind: "heard"; at: number; count: number}
  | {kind: "flag"; at: number; id: string; note: string; change?: string}
  | {kind: "review"; at: number; items: ReviewItem[]}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

function historyKey(user: string, day: string, part: string): string {
  return `history/${user}/${day}/${part}.json`
}

function dayOfKey(key: string): string | null {
  return /^history\/[^/]+\/(\d{4}-\d{2}-\d{2})\//.exec(key)?.[1] ?? null
}

export class HistoryStore {
  /** This pod's events per `<user>/<day>`; each flush rewrites the whole object. */
  private readonly own = new Map<string, {user: string; day: string; events: HistoryEvent[]}>()
  private readonly dirty = new Set<string>()
  /** Other pods' objects for days that are over; those never change again. */
  private readonly settled = new Map<string, HistoryEvent[]>()
  private objects: ObjectStore | null

  constructor(
    objects: ObjectStore | null = null,
    private readonly pod = process.env.PORTER_POD_NAME || randomUUID().slice(0, 8),
    private readonly retentionDays = HISTORY_RETENTION_DAYS,
  ) {
    this.objects = objects
  }

  /** Called once the bucket is reachable; until then the ledger is memory-only. */
  attach(objects: ObjectStore | null): void {
    this.objects = objects
  }

  record(user: string | undefined, event: HistoryEvent): void {
    if (!user) return
    const bucket = this.bucket(user, event.at)
    bucket.events.push(event)
    metrics.increment("history_events_total", {kind: event.kind})
  }

  /** Heard utterances are counted per hour, never stored as text. */
  countHeard(user: string | undefined, at: number): void {
    if (!user) return
    const hour = Math.floor(at / HOUR_MS) * HOUR_MS
    const bucket = this.bucket(user, at)
    const existing = bucket.events.find((e) => e.kind === "heard" && e.at === hour)
    if (existing && existing.kind === "heard") existing.count += 1
    else bucket.events.push({kind: "heard", at: hour, count: 1})
  }

  async flush(): Promise<void> {
    if (!this.objects || this.dirty.size === 0) return
    const keys = [...this.dirty]
    this.dirty.clear()
    await Promise.all(
      keys.map(async (key) => {
        const bucket = this.own.get(key)
        if (!bucket) return
        try {
          await this.objects!.put(historyKey(bucket.user, bucket.day, this.pod), JSON.stringify(bucket.events))
          metrics.increment("history_flushes_total", {outcome: "ok"})
        } catch (error) {
          this.dirty.add(key)
          metrics.increment("history_flushes_total", {outcome: "error"})
          log.warn("history flush failed", {key, error})
        }
      }),
    )
    // A finished day's object is never written again by this pod.
    const today = utcDay(Date.now())
    for (const [key, bucket] of this.own) {
      if (bucket.day < today && !this.dirty.has(key)) this.own.delete(key)
    }
  }

  /** Every event for this user in [from, to], from all pods plus what this pod has not flushed yet. */
  async events(user: string, from: number, to: number, now = Date.now()): Promise<HistoryEvent[]> {
    const out: HistoryEvent[] = []
    const ownKeys = new Set<string>()
    for (let day = utcDay(from); dayStart(day) <= to; day = utcDay(dayStart(day) + DAY_MS)) {
      const bucket = this.own.get(`${user}/${day}`)
      if (bucket) {
        out.push(...bucket.events)
        ownKeys.add(historyKey(user, day, this.pod))
      }
      if (!this.objects) continue
      let keys = (await this.objects.list(`history/${user}/${day}/`)).filter((key) => !ownKeys.has(key))
      const old = dayStart(day) <= now - COMPACT_AFTER_DAYS * DAY_MS
      // Once a day is compacted no pod writes to it again, so the compact
      // object is the whole day; leftover parts are a delete that did not
      // finish and would double-count.
      const compacted = historyKey(user, day, "compact")
      if (old && keys.includes(compacted)) keys = [compacted]
      const finished = day < utcDay(now)
      const bodies = await Promise.all(keys.map((key) => this.read(key, finished)))
      for (const events of bodies) out.push(...events)
      if (old && keys.length > 1) void this.compact(user, day, keys, bodies.flat())
    }
    return out.filter((e) => e.at >= from && e.at <= to).sort((a, b) => a.at - b.at)
  }

  async prune(now = Date.now()): Promise<number> {
    if (!this.objects) {
      for (const [key, bucket] of this.own) {
        if (dayStart(bucket.day) < now - this.retentionDays * DAY_MS) this.own.delete(key)
      }
      return 0
    }
    const cutoff = utcDay(now - this.retentionDays * DAY_MS)
    const stale = (await this.objects.list("history/")).filter((key) => {
      const day = dayOfKey(key)
      return day == null || day < cutoff
    })
    if (stale.length > 0) await this.objects.delete(stale)
    for (const key of stale) this.settled.delete(key)
    return stale.length
  }

  clear(): void {
    this.own.clear()
    this.dirty.clear()
    this.settled.clear()
  }

  private bucket(user: string, at: number) {
    const day = utcDay(at)
    const key = `${user}/${day}`
    let bucket = this.own.get(key)
    if (!bucket) {
      bucket = {user, day, events: []}
      this.own.set(key, bucket)
    }
    this.dirty.add(key)
    return bucket
  }

  private async read(key: string, finished: boolean): Promise<HistoryEvent[]> {
    const cached = this.settled.get(key)
    if (cached) return cached
    try {
      const body = await this.objects!.get(key)
      const events = body ? (JSON.parse(body) as HistoryEvent[]) : []
      if (finished) this.settled.set(key, events)
      return events
    } catch (error) {
      metrics.increment("history_read_failures_total")
      log.warn("history object unreadable", {key, error})
      return []
    }
  }

  private async compact(user: string, day: string, keys: string[], events: HistoryEvent[]): Promise<void> {
    try {
      const target = historyKey(user, day, "compact")
      await this.objects!.put(target, JSON.stringify(events))
      const stale = keys.filter((key) => key !== target)
      await this.objects!.delete(stale)
      for (const key of stale) this.settled.delete(key)
      this.settled.set(target, events)
    } catch (error) {
      log.warn("history compaction failed", {user, day, error})
    }
  }
}

export const historyStore = new HistoryStore()
