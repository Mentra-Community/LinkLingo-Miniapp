/**
 * Latency-first model bench for the live gloss path.
 *
 * Runs the real GLOSS_SYSTEM prompt and the real candidate selection against a
 * ladder of models, so the numbers reflect what the HUD would actually wait
 * for. Unlike `eval-gloss.ts` (one model, quality focus) this sweeps models and
 * reports the latency distribution first, quality second.
 *
 * Calls are serial: concurrency hides queueing and inflates the percentiles the
 * glasses actually experience.
 *
 *   doppler run -- bun backend/scripts/bench-gloss-models.ts
 *   doppler run -- bun backend/scripts/bench-gloss-models.ts --levels 10,50 --repeat 2
 *   doppler run -- bun backend/scripts/bench-gloss-models.ts --only cerebras,baseline
 */

import {readFileSync} from "fs"
import {join} from "path"

import {candidateWords, knownRankFor, lookupRank} from "../src/services/frequency"
import {GLOSS_SYSTEM} from "../src/services/gloss.service"
import {looksUntranslated} from "../src/services/script"

type Tier = "beginner" | "intermediate" | "advanced"

interface Sample {
  text: string
  inputLanguage: string
  outputLanguage: string
  expect: Record<Tier, string[]>
}

interface Corpus {
  anchors: Record<Tier, number>
  neverGloss: string[]
  samples: Sample[]
}

interface Candidate {
  /** Label in the report. */
  id: string
  /** Model slug as the target API names it. */
  model: string
  /** Pin the upstream so we measure that silicon, not the cheapest reseller. */
  provider?: string
  /** gpt-oss only accepts low|medium|high; Gemini accepts minimal. */
  reasoning?: "minimal" | "low" | "medium" | "high"
  /** Skip the OpenRouter hop entirely (direct vendor API). */
  baseUrl?: string
  apiKeyEnv?: string
  /** Production sends 192. Reasoning models bill thinking against this. */
  maxTokens?: number
}

/**
 * Cerebras is reachable two ways: through OpenRouter (pinned, one model) or
 * directly at api.cerebras.ai (two models, needs CEREBRAS_API_KEY). Direct
 * entries abort immediately when the key is absent.
 */
const CANDIDATES: Candidate[] = [
  {id: "baseline-flash-lite", model: "google/gemini-3.5-flash-lite", reasoning: "minimal"},
  {id: "cerebras-oss120b", model: "openai/gpt-oss-120b", provider: "cerebras", reasoning: "low"},
  {id: "cerebras-oss120b-t512", model: "openai/gpt-oss-120b", provider: "cerebras", reasoning: "low", maxTokens: 512},
  {id: "cerebras-oss120b-min", model: "openai/gpt-oss-120b", provider: "cerebras", reasoning: "minimal", maxTokens: 512},
  {id: "groq-oss120b-min", model: "openai/gpt-oss-120b", provider: "groq", reasoning: "minimal", maxTokens: 512},
  {id: "cerebras-oss120b-t1024", model: "openai/gpt-oss-120b", provider: "cerebras", reasoning: "low", maxTokens: 1024},
  {id: "groq-oss120b-t512", model: "openai/gpt-oss-120b", provider: "groq", reasoning: "low", maxTokens: 512},
  {id: "groq-oss20b-t512", model: "openai/gpt-oss-20b", provider: "groq", reasoning: "low", maxTokens: 512},
  {id: "cheapest-oss120b-t512", model: "openai/gpt-oss-120b", reasoning: "low", maxTokens: 512},
  {id: "wafer-qwen38-27b", model: "qwen/qwen3.8-27b", provider: "wafer", maxTokens: 512},
  {
    id: "cerebras-direct-oss120b",
    model: "gpt-oss-120b",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    reasoning: "low",
    maxTokens: 512,
  },
  {
    id: "cerebras-direct-qwen38-27b",
    model: "qwen-3.8-27b",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    maxTokens: 512,
  },
]

const GLOSS_SCHEMA = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {word: {type: "string"}, translation: {type: "string"}},
        required: ["word", "translation"],
      },
    },
  },
  required: ["words"],
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const levels = arg("levels", "10,50,90").split(",").map((n) => Number(n.trim()))
const repeat = Number(arg("repeat", "1"))
const only = arg("only", "").split(",").map((s) => s.trim()).filter(Boolean)

const corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "../test/fixtures/gloss-corpus.json"), "utf8"),
) as Corpus
const neverGloss = new Set(corpus.neverGloss.map((w) => w.toLowerCase()))

function tierFor(proficiency: number, anchors: Record<Tier, number>): Tier {
  const tiers = Object.entries(anchors) as Array<[Tier, number]>
  return tiers.reduce(
    (best, [tier, at]) => (Math.abs(at - proficiency) < Math.abs(anchors[best] - proficiency) ? tier : best),
    tiers[0][0],
  )
}

/** Mirrors GlossService.pickBudget, which is module-private. */
function pickBudget(proficiency: number): number {
  return proficiency < 34 ? 3 : 2
}

/** Same lowercase-the-type-names walk production uses before sending the schema. */
function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "type" && typeof item === "string" ? item.toLowerCase() : jsonSchema(item),
      ]),
    )
  }
  return value
}

/**
 * Cerebras rejects a strict json_schema unless every object node declares
 * `additionalProperties: false`; Google and Groq accept it either way. Production
 * omits it today, so switching the live path to Cerebras needs this too.
 */
function withAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withAdditionalProperties)
  if (!value || typeof value !== "object") return value
  const node = value as Record<string, unknown>
  const mapped = Object.fromEntries(
    Object.entries(node).map(([key, item]) => [key, withAdditionalProperties(item)]),
  )
  if (node.type === "object") mapped.additionalProperties = false
  return mapped
}

interface CallOutcome {
  ms: number
  text?: string
  error?: string
  outputTokens?: number
  finishReason?: string
}

async function callModel(candidate: Candidate, system: string, user: string): Promise<CallOutcome> {
  const apiKey = candidate.apiKeyEnv ? process.env[candidate.apiKeyEnv] : process.env.OPENROUTER_API_KEY
  if (!apiKey) return {ms: 0, error: `missing ${candidate.apiKeyEnv ?? "OPENROUTER_API_KEY"}`}

  const base = (candidate.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "")
  const body: Record<string, unknown> = {
    model: candidate.model,
    messages: [{role: "system", content: system}, {role: "user", content: user}],
    max_tokens: candidate.maxTokens ?? 192,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "linklingo_response",
        schema: withAdditionalProperties(jsonSchema(GLOSS_SCHEMA)),
        strict: true,
      },
    },
  }
  if (candidate.reasoning) body.reasoning = {effort: candidate.reasoning}
  if (candidate.provider) body.provider = {only: [candidate.provider], allow_fallbacks: false}

  const started = Date.now()
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Mentra LinkLingo bench",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const ms = Date.now() - started
    if (!response.ok) {
      return {ms, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`}
    }
    const data = (await response.json()) as {
      choices?: Array<{message?: {content?: string | null}; finish_reason?: string}>
      usage?: {completion_tokens?: number}
    }
    const choice = data.choices?.[0]
    const finishReason = choice?.finish_reason
    const text = choice?.message?.content
    if (typeof text !== "string") return {ms, error: "no content", finishReason}
    return {ms, text, outputTokens: data.usage?.completion_tokens, finishReason}
  } catch (error) {
    return {ms: Date.now() - started, error: (error as Error).message}
  }
}

interface Row {
  proficiency: number
  sampleIndex: number
  ms: number
  accepted: string[]
  parseFailed: boolean
  error?: string
  outputTokens?: number
  truncated: boolean
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

async function benchCandidate(candidate: Candidate): Promise<Row[] | null> {
  const rows: Row[] = []
  let consecutiveErrors = 0

  for (let pass = 0; pass < repeat; pass++) {
    for (const [sampleIndex, sample] of corpus.samples.entries()) {
      for (const proficiency of levels) {
        const knownRank = knownRankFor(proficiency)
        const maxWords = pickBudget(proficiency)
        const candidates = candidateWords(sample.text, sample.inputLanguage, [], knownRank, sample.outputLanguage)
        if (candidates.length === 0) continue

        const user = [
          `Input language: ${sample.inputLanguage}`,
          `Output language: ${sample.outputLanguage}`,
          `KNOWN=${knownRank} MAX=${maxWords}`,
          `Context: ${sample.text.slice(-400)}`,
          `Candidates: ${candidates.map((c) => `${c.word}:${c.rank}`).join(", ")}`,
          `Recent: (none)`,
        ].join("\n")

        const outcome = await callModel(candidate, GLOSS_SYSTEM, user)
        if (outcome.error) {
          consecutiveErrors++
          rows.push({
            proficiency,
            sampleIndex,
            ms: outcome.ms,
            accepted: [],
            parseFailed: false,
            truncated: false,
            error: outcome.error,
          })
          // A bad slug or unavailable provider fails identically every time;
          // stop rather than burn the whole corpus proving it.
          if (consecutiveErrors >= 3 && rows.length === consecutiveErrors) {
            console.log(`  ${candidate.id}: aborting — ${outcome.error}`)
            return null
          }
          continue
        }
        consecutiveErrors = 0

        let parsed: {words?: Array<{word?: string; translation?: string}>} = {}
        let parseFailed = false
        try {
          parsed = JSON.parse(outcome.text!) as typeof parsed
        } catch {
          parseFailed = true
        }

        // Same acceptance gate as GlossService, so quality is comparable.
        const candidateSet = new Set(candidates.map((c) => c.word.toLowerCase()))
        const accepted: string[] = []
        for (const item of parsed.words ?? []) {
          const word = (item.word ?? "").trim()
          const translation = (item.translation ?? "").trim()
          if (!word || !translation) continue
          if (word.toLowerCase() === translation.toLowerCase()) continue
          if (looksUntranslated(translation, sample.inputLanguage, sample.outputLanguage)) continue
          const bare = word.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()
          if (!candidateSet.has(bare) && !candidateSet.has(word.toLowerCase())) continue
          const rank = lookupRank(bare, sample.inputLanguage)
          if (rank != null && rank <= knownRank) continue
          accepted.push(word)
          if (accepted.length >= maxWords) break
        }

        rows.push({
          proficiency,
          sampleIndex,
          ms: outcome.ms,
          accepted,
          parseFailed,
          outputTokens: outcome.outputTokens,
          truncated: outcome.finishReason === "length",
        })
      }
    }
  }
  return rows
}

interface Summary {
  model: string
  n: number
  p50ms: number
  p90ms: number
  p95ms: number
  maxms: number
  errors: number
  parseFail: number
  trunc: number
  recall: string
  leaks: number
  noise: number
  outTok: number
}

function summarize(candidate: Candidate, rows: Row[]): Summary {
  const ok = rows.filter((r) => !r.error)
  const latencies = ok.map((r) => r.ms).sort((a, b) => a - b)

  let hits = 0
  let expected = 0
  let leaks = 0
  let noise = 0
  for (const row of ok) {
    const sample = corpus.samples[row.sampleIndex]
    const want = sample.expect[tierFor(row.proficiency, corpus.anchors)]
    expected += want.length
    hits += want.filter((w) => row.accepted.includes(w)).length
    noise += row.accepted.filter((w) => neverGloss.has(w.toLowerCase())).length
    const knownRank = knownRankFor(row.proficiency)
    leaks += row.accepted.filter((w) => {
      const rank = lookupRank(w, sample.inputLanguage)
      return rank != null && rank <= knownRank
    }).length
  }

  const outTokens = ok.map((r) => r.outputTokens ?? 0).filter((n) => n > 0)
  return {
    model: candidate.id,
    n: ok.length,
    p50ms: percentile(latencies, 0.5),
    p90ms: percentile(latencies, 0.9),
    p95ms: percentile(latencies, 0.95),
    maxms: latencies[latencies.length - 1] ?? 0,
    errors: rows.length - ok.length,
    parseFail: ok.filter((r) => r.parseFailed).length,
    trunc: ok.filter((r) => r.truncated).length,
    recall: expected ? `${hits}/${expected} = ${Math.round((100 * hits) / expected)}%` : "n/a",
    leaks,
    noise,
    outTok: outTokens.length ? Math.round(outTokens.reduce((a, b) => a + b, 0) / outTokens.length) : 0,
  }
}

const selected = CANDIDATES.filter((c) => only.length === 0 || only.some((o) => c.id.includes(o)))
const summaries: Summary[] = []
const started = Date.now()

for (const candidate of selected) {
  const label = candidate.provider ? `${candidate.model} @ ${candidate.provider}` : candidate.model
  console.log(`\n> ${candidate.id}  (${label})`)
  const rows = await benchCandidate(candidate)
  if (!rows) continue
  const summary = summarize(candidate, rows)
  summaries.push(summary)
  console.log(`  p50=${summary.p50ms}ms p95=${summary.p95ms}ms recall=${summary.recall} errors=${summary.errors}`)
  const firstError = rows.find((r) => r.error)
  if (firstError) console.log(`  first error: ${firstError.error}`)
}

console.log(`\nlevels=${levels.join(",")} repeat=${repeat} samples=${corpus.samples.length}`)
console.table(summaries.sort((a, b) => a.p50ms - b.p50ms))
console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)}s`)
