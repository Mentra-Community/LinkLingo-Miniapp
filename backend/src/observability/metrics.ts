/**
 * In-process metrics for a single-instance backend.
 *
 * There is no Prometheus scrape in this deployment, so counters and latency
 * summaries live in memory and are exposed on /metrics. Latency keeps a bounded
 * ring of recent samples so percentiles stay honest without unbounded growth.
 */

const SAMPLE_CAPACITY = 512

export interface LatencySummary {
  count: number
  minMs: number
  maxMs: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

class Histogram {
  private samples: number[] = []
  private cursor = 0
  private total = 0
  private seen = 0
  private min = Number.POSITIVE_INFINITY
  private max = 0

  observe(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    this.seen += 1
    this.total += ms
    if (ms < this.min) this.min = ms
    if (ms > this.max) this.max = ms
    if (this.samples.length < SAMPLE_CAPACITY) {
      this.samples.push(ms)
      return
    }
    this.samples[this.cursor] = ms
    this.cursor = (this.cursor + 1) % SAMPLE_CAPACITY
  }

  summary(): LatencySummary {
    if (this.seen === 0) {
      return {count: 0, minMs: 0, maxMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0}
    }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    return {
      count: this.seen,
      minMs: Math.round(this.min),
      maxMs: Math.round(this.max),
      avgMs: Math.round(this.total / this.seen),
      p50Ms: Math.round(at(0.5)),
      p95Ms: Math.round(at(0.95)),
      p99Ms: Math.round(at(0.99)),
    }
  }
}

class Registry {
  private readonly counters = new Map<string, number>()
  private readonly histograms = new Map<string, Histogram>()
  private readonly startedAt = Date.now()

  increment(name: string, labels: Record<string, string | number> = {}, by = 1): void {
    const key = seriesKey(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + by)
  }

  observe(name: string, ms: number, labels: Record<string, string | number> = {}): void {
    const key = seriesKey(name, labels)
    let histogram = this.histograms.get(key)
    if (!histogram) {
      histogram = new Histogram()
      this.histograms.set(key, histogram)
    }
    histogram.observe(ms)
  }

  snapshot(): {
    uptimeSeconds: number
    counters: Record<string, number>
    latency: Record<string, LatencySummary>
  } {
    const latency: Record<string, LatencySummary> = {}
    for (const [key, histogram] of this.histograms) {
      latency[key] = histogram.summary()
    }
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries([...this.counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
      latency,
    }
  }
}

function seriesKey(name: string, labels: Record<string, string | number>): string {
  const entries = Object.entries(labels)
  if (entries.length === 0) return name
  const suffix = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",")
  return `${name}{${suffix}}`
}

export const metrics = new Registry()
