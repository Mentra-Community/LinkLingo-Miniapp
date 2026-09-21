/**
 * Pulls the backend's review log — what the model was shown and what it
 * answered over the last day — and prints it the way a prompt author reads it,
 * with a summary of where output went wrong.
 *
 * The pod keeps ~24h in memory and forgets on redeploy, so `--save` appends
 * new entries to a local JSONL file (deduplicated by id) and `--file` reviews
 * from that archive instead of the network. Run it daily and the archive is
 * the long-term record.
 *
 * Usage:
 *   LINKLINGO_REVIEW_TOKEN=... bun run review
 *   bun run review -- --since 6h --op gloss
 *   bun run review -- --save backend/data/review.jsonl
 *   bun run review -- --file backend/data/review.jsonl --since 3d --problems
 *   bun run review -- --url http://localhost:3240 --json
 *   bun run review:doppler -- --transcripts          # last 24h of heard speech
 *   bun run review:doppler -- --transcripts --save backend/data/transcripts.jsonl
 *   bun run review:doppler -- --feedback             # problems flagged from the WebView + analyst verdicts
 *   bun run review:doppler -- --latency              # per-phase latency, grouped by client/server build
 *   bun run review:doppler -- --latency --by-session
 *   bun run review:doppler -- --latency --baseline backend/data/review-baseline.jsonl
 */

import {appendFileSync, existsSync, readFileSync} from "node:fs"

import {formatFeedbackEntry, type FeedbackEntry} from "../src/services/feedback-log"
import {formatReviewEntry, type ReviewEntry} from "../src/services/review-log"
import {formatTranscriptEntry, type TranscriptEntry} from "../src/services/transcript-log"

const DEFAULT_URL = "https://linklingo-miniapp-dev.mentraglass.com"
/** Reject reasons that point at the prompt rather than at the learner's level. */
const PROMPT_PROBLEMS = new Set(["untranslated", "echo", "not_candidate", "empty"])

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback
}

function parseTime(raw: string | undefined, now = Date.now()): number | undefined {
  if (!raw) return undefined
  const relative = /^(\d+)([smhd])$/.exec(raw.trim())
  if (relative) {
    const unit = {s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000}[relative[2] as "s" | "m" | "h" | "d"]
    return now - Number(relative[1]) * unit
  }
  if (/^\d+$/.test(raw)) return Number(raw)
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? undefined : parsed
}

if (flag("help")) {
  console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^\/\*\*?\s?| \* ?/gm, ""))
  process.exit(0)
}

const since = arg("since", "24h")!
const op = arg("op")
const url = (arg("url") ?? process.env.LINKLINGO_REVIEW_URL ?? DEFAULT_URL).replace(/\/$/, "")
const file = arg("file")
const save = arg("save")
const limit = arg("limit", "2000")!
const wantTranscripts = flag("transcripts")
const wantFeedback = flag("feedback")
const wantLatency = flag("latency")
const bySession = flag("by-session")
const baselineFile = arg("baseline")

async function fetchFromReview<T>(path: string, query: URLSearchParams): Promise<T[]> {
  const token = process.env.LINKLINGO_REVIEW_TOKEN
  if (!token) {
    console.error("LINKLINGO_REVIEW_TOKEN is required (same value the backend runs with), or pass --file")
    process.exit(1)
  }
  const response = await fetch(`${url}/api/review/${path}?${query}`, {
    headers: {Authorization: `Bearer ${token}`},
  })
  if (response.status === 404) {
    console.error(`${url} has no review log: LINKLINGO_REVIEW_TOKEN is not set on the backend, or it predates this feature`)
    process.exit(1)
  }
  if (!response.ok) {
    console.error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    process.exit(1)
  }
  return ((await response.json()) as {entries: T[]}).entries
}

async function fetchEntries(): Promise<ReviewEntry[]> {
  const token = process.env.LINKLINGO_REVIEW_TOKEN
  if (!token) {
    console.error("LINKLINGO_REVIEW_TOKEN is required (same value the backend runs with), or pass --file")
    process.exit(1)
  }
  const query = new URLSearchParams({since, limit})
  if (op) query.set("op", op)
  const response = await fetch(`${url}/api/review/entries?${query}`, {
    headers: {Authorization: `Bearer ${token}`},
  })
  if (response.status === 404) {
    console.error(`${url} has no review log: LINKLINGO_REVIEW_TOKEN is not set on the backend, or it predates this feature`)
    process.exit(1)
  }
  if (!response.ok) {
    console.error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    process.exit(1)
  }
  return ((await response.json()) as {entries: ReviewEntry[]}).entries
}

async function fetchTranscripts(): Promise<TranscriptEntry[]> {
  const token = process.env.LINKLINGO_REVIEW_TOKEN
  if (!token) {
    console.error("LINKLINGO_REVIEW_TOKEN is required (same value the backend runs with), or pass --file")
    process.exit(1)
  }
  const query = new URLSearchParams({since, limit})
  const disposition = arg("disposition")
  if (disposition) query.set("disposition", disposition)
  const response = await fetch(`${url}/api/review/transcripts?${query}`, {
    headers: {Authorization: `Bearer ${token}`},
  })
  if (response.status === 404) {
    console.error(`${url} has no review log: LINKLINGO_REVIEW_TOKEN is not set on the backend, or it predates this feature`)
    process.exit(1)
  }
  if (!response.ok) {
    console.error(`${url} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    process.exit(1)
  }
  return ((await response.json()) as {entries: TranscriptEntry[]}).entries
}

function readArchive(path: string): ReviewEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReviewEntry)
}

function archive(path: string, entries: ReviewEntry[]): number {
  const known = new Set(readArchive(path).map((e) => e.id))
  const fresh = entries.filter((e) => !known.has(e.id))
  if (fresh.length > 0) appendFileSync(path, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n")
  return fresh.length
}

// ---- Latency view -----------------------------------------------------------

/**
 * A latency figure is only worth acting on if enough calls went into it, so
 * `n` travels with every band rather than being quoted once per table.
 */
interface Band {
  n: number
  p50: number
  p95: number
}

function bandOf(values: Array<number | undefined>): Band {
  const sorted = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return {n: 0, p50: 0, p95: 0}
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return {n: sorted.length, p50: at(0.5), p95: at(0.95)}
}

function renderBand(label: string, band: Band): string {
  if (band.n === 0) return `  ${label.padEnd(18)}      -       -   (n=0)`
  return `  ${label.padEnd(18)}${String(band.p50).padStart(6)}${String(band.p95).padStart(8)}   (n=${band.n})`
}

/** Buckets are computed here, not at write time, so the boundaries stay changeable. */
const IDLE_BUCKETS: Array<{label: string; max: number}> = [
  {label: "<30s", max: 30_000},
  {label: "30s-2m", max: 120_000},
  {label: ">2m", max: Number.POSITIVE_INFINITY},
]

function byIdle(
  rows: ReviewEntry[],
  idleOf: (e: ReviewEntry) => number | undefined,
  valueOf: (e: ReviewEntry) => number | undefined,
): string {
  const parts: string[] = []
  for (const bucket of IDLE_BUCKETS) {
    const lower = IDLE_BUCKETS[IDLE_BUCKETS.indexOf(bucket) - 1]?.max ?? 0
    const band = bandOf(
      rows
        .filter((e) => {
          const idle = idleOf(e)
          return idle != null && idle >= lower && idle < bucket.max
        })
        .map(valueOf),
    )
    if (band.n > 0) parts.push(`${bucket.label} n=${band.n} ${band.p50}/${band.p95}`)
  }
  return parts.join("   ") || "(no idle data)"
}

function tally(values: Array<string | undefined>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) {
    if (v == null) continue
    out[v] = (out[v] ?? 0) + 1
  }
  return out
}

function renderTally(counts: Record<string, number>): string {
  return (
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k} ${n}`)
      .join("  ") || "(none)"
  )
}

interface GroupSummary {
  key: string
  n: number
  triggerToRender: Band
  queue: Band
  phoneRtt: Band
  server: Band
  model: Band
  render: Band
  auth: Band
  select: Band
}

function summariseGroup(key: string, rows: ReviewEntry[]): GroupSummary {
  return {
    key,
    n: rows.length,
    triggerToRender: bandOf(rows.map((e) => e.triggerToRenderMs)),
    queue: bandOf(rows.map((e) => e.queueWaitMs)),
    phoneRtt: bandOf(rows.map((e) => e.clientRoundTripMs)),
    server: bandOf(rows.map((e) => e.totalMs)),
    model: bandOf(rows.map((e) => e.llmMs ?? e.geminiMs)),
    render: bandOf(rows.map((e) => e.renderMs)),
    auth: bandOf(rows.map((e) => e.authMs)),
    select: bandOf(rows.map((e) => e.selectMs)),
  }
}

function groupKey(e: ReviewEntry): string {
  const client = `${e.clientVersion ?? "?"}/${e.clientBuildId ?? "?"}`
  return `client ${client} x server ${e.serverBuildId ?? "?"} x ${e.model}`
}

function printGroup(rows: ReviewEntry[], key: string, bySession: boolean): GroupSummary {
  const summary = summariseGroup(key, rows)
  const sessions = new Set(rows.map((e) => e.sessionId).filter(Boolean))
  const span = rows.length > 1 ? rows[rows.length - 1]!.at - rows[0]!.at : 0
  const perMinute = span > 0 ? (rows.length / (span / 60_000)).toFixed(1) : "n/a"

  console.log("")
  console.log(`${key}   n=${rows.length}`)
  console.log("                      p50     p95")
  console.log(renderBand("trigger->render", summary.triggerToRender))
  console.log(renderBand("queue", summary.queue))
  console.log(renderBand("phone RTT", summary.phoneRtt))
  console.log(renderBand("server", summary.server))
  console.log(renderBand("model", summary.model))
  console.log(renderBand("render", summary.render))
  if (summary.auth.n > 0) console.log(renderBand("auth", summary.auth))
  if (summary.select.n > 0) console.log(renderBand("candidate select", summary.select))

  const reasons = tally(rows.map((e) => e.queueReason))
  if (Object.keys(reasons).length > 0) console.log(`  queue reason:    ${renderTally(reasons)}`)
  const triggers = tally(rows.map((e) => e.trigger))
  if (Object.keys(triggers).length > 0) console.log(`  trigger:         ${renderTally(triggers)}`)

  console.log(`  phone RTT/idle:  ${byIdle(rows, (e) => e.networkIdleMs, (e) => e.clientRoundTripMs)}`)
  console.log(`  model/llm idle:  ${byIdle(rows, (e) => e.llmIdleMs, (e) => e.llmMs ?? e.geminiMs)}`)
  console.log(`  outcomes:        ${renderTally(tally(rows.map((e) => e.outcome)))}`)
  console.log(
    `  volume:          ${sessions.size || "?"} sessions, ${perMinute} req/min over ${Math.round(span / 1000)}s`,
  )

  if (bySession && sessions.size > 1) {
    for (const session of sessions) {
      const mine = rows.filter((e) => e.sessionId === session)
      const band = bandOf(mine.map((e) => e.triggerToRenderMs))
      const cold = mine.find((e) => e.requestSeq === 1)
      console.log(
        `    session ${session}: n=${mine.length} trigger->render ${band.p50}/${band.p95}` +
          (cold?.clientRoundTripMs != null ? `  first RTT ${cold.clientRoundTripMs}ms` : ""),
      )
    }
  }
  return summary
}

/** Shadow results live on the transcript tape, keyed by the utterance they describe. */
function printShadow(transcripts: TranscriptEntry[]): void {
  const withShadow = transcripts.filter((t) => t.shadowInterim?.length)
  const interimCapable = transcripts.filter((t) => t.disposition !== "skipped_language")
  console.log("")
  console.log("=".repeat(72))
  if (withShadow.length === 0) {
    console.log("shadow interim: no observations (phones predate 1.0.16, or no interims were seen)")
    return
  }
  const byClient = new Map<string, TranscriptEntry[]>()
  for (const t of withShadow) {
    const key = `${t.clientVersion ?? "?"}/${t.clientBuildId ?? "?"}`
    byClient.set(key, [...(byClient.get(key) ?? []), t])
  }
  for (const [client, rows] of byClient) {
    console.log(
      `shadow interim (client ${client}) — ${rows.length} of ${interimCapable.length} utterances produced a trigger`,
    )
    for (const variant of ["stable300", "growth6"] as const) {
      const hits = rows.flatMap((t) => (t.shadowInterim ?? []).filter((o) => o.variant === variant))
      if (hits.length === 0) {
        console.log(`  ${variant.padEnd(10)} never fired`)
        continue
      }
      const band = bandOf(hits.map((o) => o.leadMs))
      const dupes = hits.filter((o) => o.wouldDuplicate).length
      const share = Math.round((100 * hits.length) / Math.max(1, interimCapable.length))
      console.log(
        `  ${variant.padEnd(10)} fired ${String(hits.length).padStart(4)} (${share}%)  ` +
          `lead p50 ${band.p50}ms p95 ${band.p95}ms  ` +
          `would-duplicate ${dupes} (${Math.round((100 * dupes) / hits.length)}%)`,
      )
    }
  }
  console.log("Read: a high fire rate with a long lead and few duplicates is what makes Phase 1 worth shipping.")
}

function printLatencyDelta(current: ReviewEntry[], baselinePath: string): void {
  const baseline = readArchive(baselinePath)
  if (baseline.length === 0) {
    console.log(`\nno baseline entries in ${baselinePath}`)
    return
  }
  const metrics: Array<[string, (e: ReviewEntry) => number | undefined]> = [
    ["trigger->render", (e) => e.triggerToRenderMs],
    ["queue", (e) => e.queueWaitMs],
    ["phone RTT", (e) => e.clientRoundTripMs],
    ["server", (e) => e.totalMs],
    ["model", (e) => e.llmMs ?? e.geminiMs],
  ]
  console.log("")
  console.log("=".repeat(72))
  console.log(`delta vs ${baselinePath} (n=${baseline.length} baseline, n=${current.length} current)`)
  console.log("                    base p50   now p50     delta")
  for (const [label, pick] of metrics) {
    const before = bandOf(baseline.map(pick))
    const after = bandOf(current.map(pick))
    if (before.n === 0 && after.n === 0) continue
    const delta = after.p50 - before.p50
    const sign = delta > 0 ? "+" : ""
    console.log(
      `  ${label.padEnd(18)}${String(before.p50).padStart(8)}${String(after.p50).padStart(10)}` +
        `${(sign + delta).padStart(10)}ms  (n ${before.n} -> ${after.n})`,
    )
  }
}

if (wantFeedback) {
  let reports: FeedbackEntry[]
  if (file) {
    const cutoff = parseTime(since) ?? 0
    reports = readArchive(file).filter((e) => e.at >= cutoff) as unknown as FeedbackEntry[]
  } else {
    reports = await fetchFromReview<FeedbackEntry>("feedback", new URLSearchParams({since, limit}))
    if (save) {
      const added = archive(save, reports as unknown as ReviewEntry[])
      console.error(`archived ${added} new feedback reports to ${save}`)
    }
  }
  reports.sort((a, b) => a.at - b.at)
  if (flag("json")) {
    console.log(JSON.stringify(reports, null, 2))
    process.exit(0)
  }
  for (const entry of reports) {
    console.log(formatFeedbackEntry(entry))
    console.log()
  }
  const source = file ? `archive ${file}` : url
  if (reports.length === 0) {
    console.log(`no feedback in ${source} since ${since}`)
    process.exit(0)
  }
  const latencies = reports.map((e) => e.analysis.totalMs).sort((a, b) => a - b)
  console.log("=".repeat(72))
  console.log(`${reports.length} feedback exchanges from ${source} since ${since}`)
  console.log(`models:      ${[...new Set(reports.map((e) => e.analysis.model))].join(", ")}`)
  console.log(`latency:     p50=${latencies[Math.floor(latencies.length * 0.5)]}ms max=${latencies[latencies.length - 1]}ms`)
  process.exit(0)
}

if (wantTranscripts) {
  let tape: TranscriptEntry[]
  if (file) {
    const cutoff = parseTime(since) ?? 0
    tape = readArchive(file).filter((e) => e.at >= cutoff) as unknown as TranscriptEntry[]
  } else {
    tape = await fetchTranscripts()
    if (save) {
      const added = archive(save, tape as unknown as ReviewEntry[])
      console.error(`archived ${added} new transcripts to ${save}`)
    }
  }
  tape.sort((a, b) => a.at - b.at)
  if (flag("json")) {
    console.log(JSON.stringify(tape, null, 2))
    process.exit(0)
  }
  for (const entry of tape) {
    console.log(formatTranscriptEntry(entry))
    console.log()
  }
  const source = file ? `archive ${file}` : url
  if (tape.length === 0) {
    console.log(`no transcripts in ${source} since ${since}`)
    process.exit(0)
  }
  const count = (items: string[]) =>
    Object.entries(items.reduce<Record<string, number>>((acc, k) => ({...acc, [k]: (acc[k] ?? 0) + 1}), {}))
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join("  ")
  const withCandidates = tape.filter((e) => e.wouldGloss.length > 0)
  const silent = tape.filter((e) => e.disposition === "queued_gloss" && e.wouldGloss.length === 0)
  console.log("=".repeat(72))
  console.log(`${tape.length} transcripts from ${source} since ${since}`)
  console.log(`disposition: ${count(tape.map((e) => e.disposition))}`)
  console.log(`languages:   ${count(tape.map((e) => `${e.inputLanguage}→${e.outputLanguage}`))}`)
  console.log(`would gloss: ${withCandidates.length}/${tape.length} utterances had rare-word candidates`)
  if (silent.length > 0) {
    console.log()
    console.log("queued but no candidates — speech the model never saw, and the filter offered nothing:")
    for (const entry of silent) console.log(`  ${entry.text}`)
  }
  const skippedLang = tape.filter((e) => e.disposition === "skipped_language")
  if (skippedLang.length > 0) {
    console.log()
    console.log(`skipped as the learner's own language (${skippedLang.length}):`)
    for (const entry of skippedLang.slice(-8)) console.log(`  ${entry.text.slice(0, 80)}`)
  }
  process.exit(0)
}

let entries: ReviewEntry[]
if (file) {
  const cutoff = parseTime(since) ?? 0
  entries = readArchive(file).filter((e) => e.at >= cutoff && (!op || e.op === op))
} else {
  entries = await fetchEntries()
  if (save) {
    const added = archive(save, entries)
    console.error(`archived ${added} new entries to ${save}`)
  }
}

entries.sort((a, b) => a.at - b.at)

if (wantLatency) {
  const source = file ? `archive ${file}` : url
  if (entries.length === 0) {
    console.log(`no entries in ${source} since ${since}`)
    process.exit(0)
  }
  const glossOnly = entries.filter((e) => e.op === "gloss")
  const groups = new Map<string, ReviewEntry[]>()
  for (const entry of glossOnly) {
    const key = groupKey(entry)
    groups.set(key, [...(groups.get(key) ?? []), entry])
  }

  console.log("=".repeat(72))
  console.log(`latency from ${source} since ${since} — ${glossOnly.length} gloss calls`)
  console.log("A p95 over fewer than 30 calls is printed but should not be acted on.")
  for (const [key, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    printGroup(rows, key, bySession)
  }

  const missing = glossOnly.filter((e) => e.triggerToRenderMs == null).length
  if (missing > 0) {
    console.log("")
    console.log(
      `${missing}/${glossOnly.length} calls have no trigger->render: the phone reports a call's timings on ` +
        `the following request, so the newest call in each session is always pending.`,
    )
  }

  // Shadow observations ride the transcript tape, so they need a second fetch.
  if (!file) {
    try {
      printShadow(await fetchTranscripts())
    } catch {
      console.log("\nshadow interim: transcripts unavailable")
    }
  }

  if (baselineFile) printLatencyDelta(glossOnly, baselineFile)
  process.exit(0)
}

if (flag("problems")) {
  entries = entries.filter(
    (e) => e.rejected.some((r) => PROMPT_PROBLEMS.has(r.reason)) || e.outcome === "parse_failed" || e.outcome === "llm_error",
  )
}

if (flag("json")) {
  console.log(JSON.stringify(entries, null, 2))
  process.exit(0)
}

for (const entry of entries) {
  console.log(formatReviewEntry(entry))
  console.log()
}

// ---- Summary ----------------------------------------------------------------
const source = file ? `archive ${file}` : url
if (entries.length === 0) {
  console.log(`no entries in ${source} since ${since}${op ? ` for ${op}` : ""}`)
  process.exit(0)
}

const count = (items: string[]) =>
  Object.entries(items.reduce<Record<string, number>>((acc, k) => ({...acc, [k]: (acc[k] ?? 0) + 1}), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join("  ")

const rejects = entries.flatMap((e) => e.rejected)
const problems = rejects.filter((r) => PROMPT_PROBLEMS.has(r.reason))
const prompts = [...new Set(entries.map((e) => `${e.op}:${e.promptVersion}`))]
const shown = entries.reduce((n, e) => n + e.accepted.length, 0)
const latencies = entries.map((e) => e.totalMs).sort((a, b) => a - b)
const modelLatencies = entries.map((e) => e.geminiMs).filter((n): n is number => n != null).sort((a, b) => a - b)
const phoneLatencies = entries
  .map((e) => e.clientRoundTripMs)
  .filter((n): n is number => n != null)
  .sort((a, b) => a - b)
const band = (sorted: number[]) =>
  `p50=${sorted[Math.floor(sorted.length * 0.5)]}ms p95=${sorted[Math.floor(sorted.length * 0.95)]}ms max=${sorted[sorted.length - 1]}ms`

console.log("=".repeat(72))
console.log(`${entries.length} entries from ${source} since ${since}${op ? ` (${op})` : ""}`)
console.log(`prompts:     ${prompts.join(", ")}`)
console.log(`outcomes:    ${count(entries.map((e) => e.outcome))}`)
console.log(`languages:   ${count(entries.map((e) => `${e.inputLanguage}→${e.outputLanguage}`))}`)
console.log(`shown:       ${shown} words over ${entries.length} calls`)
if (rejects.length > 0) console.log(`dropped:     ${count(rejects.map((r) => r.reason))}`)
console.log(`models:      ${count(entries.map((e) => e.model))}`)
// Three nested windows: what the learner waited for, what the server spent,
// and what the model spent. Gaps between them localise a regression to the
// network, the candidate filter, or the model itself.
console.log(`server:      ${band(latencies)}`)
if (modelLatencies.length > 0) console.log(`model:       ${band(modelLatencies)}`)
if (phoneLatencies.length > 0) {
  console.log(`phone rtt:   ${band(phoneLatencies)}  (${phoneLatencies.length}/${entries.length} calls reported)`)
} else {
  console.log(`phone rtt:   not reported — phones on a build older than clientRoundTripMs`)
}
if (problems.length > 0) {
  console.log()
  console.log(`prompt problems (${problems.length}): the model broke a rule and the filter caught it`)
  for (const entry of entries) {
    for (const r of entry.rejected) {
      if (!PROMPT_PROBLEMS.has(r.reason)) continue
      const proposal = entry.proposed?.find((p) => p.word === r.word)
      const pair = proposal ? `${proposal.word} -> ${proposal.translation}` : r.word
      console.log(`  ${r.reason.padEnd(13)} ${pair}    ← "${entry.context.slice(-60)}"`)
    }
  }
}
console.log()
console.log("tip: rerun with --problems to see only the calls where the filter had to intervene")
