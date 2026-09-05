/**
 * Background-side logging and counters.
 *
 * The background runs in a bare JavaScript engine, so this deliberately uses
 * only `console` and `Date.now()` — no `performance`, no DOM, no Node built-ins.
 * Every line is prefixed so `adb logcat` can be filtered down to LinkLingo.
 */

import type {LinkLingoDiagnostics} from "../shared/types"

export type MiniLogLevel = "debug" | "info" | "warn" | "error" | "silent"

const LEVEL_WEIGHT: Record<MiniLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

// Inlined at build time by build.ts for any MENTRA_PUBLIC_* variable.
const CONFIGURED_LEVEL = (process.env.MENTRA_PUBLIC_LINKLINGO_LOG_LEVEL || "info").toLowerCase()

const activeLevel: MiniLogLevel = (
  CONFIGURED_LEVEL in LEVEL_WEIGHT ? CONFIGURED_LEVEL : "info"
) as MiniLogLevel

export type LogFields = Record<string, unknown>

function render(fields: LogFields | undefined): string {
  if (!fields) return ""
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (value instanceof Error) {
      parts.push(`${key}=${value.name}:${value.message}`)
      continue
    }
    if (typeof value === "object" && value !== null) {
      try {
        parts.push(`${key}=${JSON.stringify(value)}`)
      } catch {
        parts.push(`${key}=[unserializable]`)
      }
      continue
    }
    const text = String(value)
    parts.push(`${key}=${/\s/.test(text) ? JSON.stringify(text) : text}`)
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : ""
}

export interface MiniLogger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(fields: LogFields): MiniLogger
}

export function createLogger(scope: string, bound: LogFields = {}): MiniLogger {
  const emit = (level: MiniLogLevel, message: string, fields?: LogFields) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[activeLevel]) return
    const merged = fields ? {...bound, ...fields} : bound
    const line = `[linklingo:${scope}] ${message}${render(merged)}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.log(line)
  }
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(scope, {...bound, ...fields}),
  }
}

export type DiagnosticsSnapshot = LinkLingoDiagnostics

/**
 * Counters for the phone. Logs scroll away and `adb logcat` needs a cable, so
 * the running totals are also pushed to the WebView for on-device inspection.
 */
class BackgroundDiagnostics {
  private readonly startedAt = Date.now()
  private readonly counters: Record<string, number> = {}
  private readonly timings: Record<string, {count: number; total: number; last: number; max: number}> = {}
  private lastError: string | null = null
  private lastErrorAt: number | null = null

  increment(name: string, by = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + by
  }

  observe(name: string, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return
    const entry = this.timings[name] ?? {count: 0, total: 0, last: 0, max: 0}
    entry.count += 1
    entry.total += ms
    entry.last = ms
    if (ms > entry.max) entry.max = ms
    this.timings[name] = entry
  }

  recordError(message: string): void {
    this.lastError = message
    this.lastErrorAt = Date.now()
    this.increment("errors")
  }

  snapshot(): DiagnosticsSnapshot {
    const timings: DiagnosticsSnapshot["timings"] = {}
    for (const [name, entry] of Object.entries(this.timings)) {
      timings[name] = {
        count: entry.count,
        avgMs: Math.round(entry.total / entry.count),
        lastMs: Math.round(entry.last),
        maxMs: Math.round(entry.max),
      }
    }
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      counters: {...this.counters},
      timings,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    }
  }
}

export const diagnostics = new BackgroundDiagnostics()
export const logLevel = activeLevel
