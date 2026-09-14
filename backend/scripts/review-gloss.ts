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
  const causes = reports.reduce<Record<string, number>>((acc, e) => {
    acc[e.analysis.likelyCause] = (acc[e.analysis.likelyCause] ?? 0) + 1
    return acc
  }, {})
  console.log("=".repeat(72))
  console.log(`${reports.length} feedback reports from ${source} since ${since}`)
  console.log(
    `causes:      ${Object.entries(causes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join("  ")}`,
  )
  const promptChanges = reports.filter((e) => e.analysis.suggestedPromptChange)
  if (promptChanges.length > 0) {
    console.log()
    console.log(`suggested prompt changes (${promptChanges.length}):`)
    for (const entry of promptChanges) console.log(`  - ${entry.analysis.suggestedPromptChange}`)
  }
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

console.log("=".repeat(72))
console.log(`${entries.length} entries from ${source} since ${since}${op ? ` (${op})` : ""}`)
console.log(`prompts:     ${prompts.join(", ")}`)
console.log(`outcomes:    ${count(entries.map((e) => e.outcome))}`)
console.log(`languages:   ${count(entries.map((e) => `${e.inputLanguage}→${e.outputLanguage}`))}`)
console.log(`shown:       ${shown} words over ${entries.length} calls`)
if (rejects.length > 0) console.log(`dropped:     ${count(rejects.map((r) => r.reason))}`)
console.log(
  `latency:     p50=${latencies[Math.floor(latencies.length * 0.5)]}ms p95=${latencies[Math.floor(latencies.length * 0.95)]}ms`,
)
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
