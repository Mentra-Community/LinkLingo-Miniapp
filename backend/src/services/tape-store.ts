/**
 * Durable copy of the 24h tapes. The in-memory rings are what the review API
 * and the analyst read; this store is what a new pod loads after Karpenter
 * evicts the previous one. A missing store leaves the rings memory-only.
 */

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"

const log = createLogger("tape")

export type TapeKind = "transcript" | "review" | "feedback"

export interface StoredEntry {
  id: string
  at: number
  user?: string
}

export interface ObjectStore {
  put(key: string, body: string): Promise<void>
  get(key: string): Promise<string | null>
  list(prefix: string): Promise<string[]>
  delete(keys: string[]): Promise<void>
}

const KINDS: TapeKind[] = ["transcript", "review", "feedback"]
const DEFAULT_RETENTION_HOURS = 24

function retentionMs(): number {
  const raw = Number(process.env.LINKLINGO_REVIEW_RETENTION_HOURS)
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_HOURS
  return hours * 3_600_000
}

/** `v1/<kind>/<at padded>/<id>.json` so a listing can drop expired rows without reading them. */
export function tapeKey(kind: TapeKind, at: number, id: string): string {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `v1/${kind}/${String(Math.trunc(at)).padStart(16, "0")}/${safeId}.json`
}

export function tapeKeyAt(key: string): number | null {
  const match = /^v1\/(?:transcript|review|feedback)\/(\d+)\//.exec(key)
  if (!match) return null
  const at = Number(match[1])
  return Number.isFinite(at) ? at : null
}

export function mergeById<T extends StoredEntry>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>()
  for (const entry of current) byId.set(entry.id, entry)
  for (const entry of incoming) byId.set(entry.id, entry)
  return [...byId.values()].sort((a, b) => a.at - b.at)
}

type Persister = (kind: TapeKind, entry: StoredEntry) => void

let persister: Persister | null = null
const inflight = new Set<Promise<void>>()

/** Installed at boot when a bucket is configured. Tests install a fake. */
export function setTapePersister(next: Persister | null): void {
  persister = next
}

export function persistTape(kind: TapeKind, entry: StoredEntry): void {
  if (!persister) return
  try {
    persister(kind, entry)
  } catch (error) {
    metrics.increment("tape_write_failures_total", {kind})
    log.warn("tape persist threw", {kind, id: entry.id, error})
  }
}

export function trackTapeWrite(task: Promise<void>): void {
  inflight.add(task)
  void task.finally(() => inflight.delete(task))
}

/** Wait for puts already handed to the store. Called on SIGTERM before exit. */
export async function flushTape(): Promise<void> {
  await Promise.all([...inflight])
}

export function tapeEnabled(): boolean {
  return persister != null
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, () => worker()))
  return results
}

/**
 * One JSON object per tape row. Overwriting the same key updates a row in
 * place, which is how a gloss call grows its phone timings one request later.
 */
export class ObjectTape {
  constructor(
    private readonly objects: ObjectStore,
    private readonly retention = retentionMs(),
  ) {}

  async put(kind: TapeKind, entry: StoredEntry): Promise<void> {
    await this.objects.put(tapeKey(kind, entry.at, entry.id), JSON.stringify(entry))
  }

  async load(kind: TapeKind, now = Date.now()): Promise<StoredEntry[]> {
    const cutoff = now - this.retention
    const keys = (await this.objects.list(`v1/${kind}/`)).filter((key) => {
      const at = tapeKeyAt(key)
      return at != null && at >= cutoff
    })
    const bodies = await mapPool(keys, 12, (key) => this.objects.get(key))
    const entries: StoredEntry[] = []
    for (const body of bodies) {
      if (!body) continue
      try {
        const parsed = JSON.parse(body) as StoredEntry
        if (typeof parsed?.id === "string" && typeof parsed.at === "number") entries.push(parsed)
      } catch {
        metrics.increment("tape_read_failures_total", {kind})
      }
    }
    return entries.sort((a, b) => a.at - b.at)
  }

  async loadAll(now = Date.now()): Promise<Record<TapeKind, StoredEntry[]>> {
    const [transcript, review, feedback] = await Promise.all(KINDS.map((kind) => this.load(kind, now)))
    return {transcript, review, feedback}
  }

  async prune(now = Date.now()): Promise<number> {
    const cutoff = now - this.retention
    let removed = 0
    for (const kind of KINDS) {
      const stale = (await this.objects.list(`v1/${kind}/`)).filter((key) => {
        const at = tapeKeyAt(key)
        return at == null || at < cutoff
      })
      if (stale.length === 0) continue
      await this.objects.delete(stale)
      removed += stale.length
    }
    return removed
  }
}
