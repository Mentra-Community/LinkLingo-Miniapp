/**
 * Structured logging for the LinkLingo backend.
 *
 * Emits logfmt by default because Porter's log viewer is read by humans, and
 * JSON when LOG_FORMAT=json so a collector can parse it. Field values are
 * redacted by key name so an API key can never be logged by accident.
 */

import {currentRequestContext} from "./context"

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent"

export type LogFields = Record<string, unknown>

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

/**
 * Anchored at the end of the field name so a secret-bearing field like `apiKey`
 * or `authorization` is masked, while deliberately safe descriptors such as
 * `llmKeySource`, `keyFingerprint`, or `keyrings` still print. A substring match
 * would redact exactly the fields that exist to be read.
 */
const REDACT_KEY = /(api_?key|key|token|secret|password|passwd|authorization|credentials?|jwt|bearer)s?$/i
const MAX_VALUE_CHARS = 500

function parseLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "").toLowerCase()
  if (value in LEVEL_WEIGHT) return value as LogLevel
  return "info"
}

function resolveLevel(): LogLevel {
  return parseLevel(process.env.LOG_LEVEL)
}

function resolveFormat(): "json" | "logfmt" {
  return (process.env.LOG_FORMAT ?? "").toLowerCase() === "json" ? "json" : "logfmt"
}

/**
 * Keeps a long single-line value from swallowing the log stream while still
 * showing enough of it to be useful.
 */
function truncate(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value
  return `${value.slice(0, MAX_VALUE_CHARS)}…(+${value.length - MAX_VALUE_CHARS})`
}

function scrub(key: string, value: unknown): unknown {
  // Numbers and booleans cannot carry a credential, which keeps token *counts*
  // such as promptTokens readable while `token` itself stays masked.
  const isScalar = typeof value === "number" || typeof value === "boolean" || value == null
  if (REDACT_KEY.test(key) && !isScalar) return "[redacted]"
  if (value instanceof Error) return truncate(`${value.name}: ${value.message}`)
  if (typeof value === "string") return truncate(value)
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value
  try {
    return truncate(JSON.stringify(value))
  } catch {
    return "[unserializable]"
  }
}

function quote(value: string): string {
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value
}

function formatLogfmt(level: LogLevel, scope: string, message: string, fields: LogFields): string {
  const parts = [`level=${level}`, `scope=${scope}`, `msg=${quote(message)}`]
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue
    const value = scrub(key, raw)
    parts.push(`${key}=${quote(String(value))}`)
  }
  return parts.join(" ")
}

function formatJson(level: LogLevel, scope: string, message: string, fields: LogFields): string {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
  }
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue
    payload[key] = scrub(key, raw)
  }
  return JSON.stringify(payload)
}

function emit(level: LogLevel, scope: string, message: string, fields: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[resolveLevel()]) return
  const request = currentRequestContext()
  const enriched: LogFields = request
    ? {req: request.requestId, user: request.userId, ...fields}
    : fields
  const line =
    resolveFormat() === "json"
      ? formatJson(level, scope, message, enriched)
      : formatLogfmt(level, scope, message, enriched)
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** Returns a logger that stamps `fields` onto every subsequent line. */
  child(fields: LogFields): Logger
  /** Returns a function that reports elapsed milliseconds when called. */
  startTimer(): () => number
}

export function createLogger(scope: string, bound: LogFields = {}): Logger {
  const merge = (fields?: LogFields): LogFields => (fields ? {...bound, ...fields} : bound)
  return {
    debug: (message, fields) => emit("debug", scope, message, merge(fields)),
    info: (message, fields) => emit("info", scope, message, merge(fields)),
    warn: (message, fields) => emit("warn", scope, message, merge(fields)),
    error: (message, fields) => emit("error", scope, message, merge(fields)),
    child: (fields) => createLogger(scope, {...bound, ...fields}),
    startTimer: () => {
      const started = Date.now()
      return () => Date.now() - started
    },
  }
}

export const logLevel = resolveLevel
export const logFormat = resolveFormat
