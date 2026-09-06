/**
 * Live gloss eval. Runs the labelled corpus through the real GlossService at a
 * ladder of proficiencies and reports whether the words that reach the glasses
 * are the ones that tier actually needs.
 *
 * Deliberately not part of `bun test`: it costs real Gemini calls and its
 * numbers move with the model.
 *
 * Usage:
 *   GEMINI_API_KEY=... bun backend/scripts/eval-gloss.ts
 *   GEMINI_API_KEY=... bun backend/scripts/eval-gloss.ts --levels 10,50,90 --repeat 2
 */

import {readFileSync} from "fs"
import {join} from "path"

import {knownRankFor, lookupRank} from "../src/services/frequency"
import {resolveApiKey, resolveModel} from "../src/services/gemini"
import {glossService} from "../src/services/gloss.service"

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

/**
 * Labels are calibrated at the anchor proficiencies, so an off-anchor level is
 * scored against the nearest one. Recall at, say, 67 is therefore indicative
 * rather than exact; the leak and never-gloss checks stay exact at any level.
 */
function tierFor(proficiency: number, anchors: Record<Tier, number>): Tier {
  const tiers = Object.entries(anchors) as Array<[Tier, number]>
  return tiers.reduce((best, [tier, at]) =>
    Math.abs(at - proficiency) < Math.abs(anchors[best] - proficiency) ? tier : best,
  tiers[0][0])
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const levels = arg("levels", "10,50,90").split(",").map((n) => Number(n.trim()))
const repeat = Number(arg("repeat", "1"))
const concurrency = Number(arg("concurrency", "3"))

if (!resolveApiKey()) {
  console.error("GEMINI_API_KEY is required for the live eval")
  process.exit(1)
}

const corpus = JSON.parse(
  readFileSync(join(import.meta.dir, "../test/fixtures/gloss-corpus.json"), "utf8"),
) as Corpus

const neverGloss = new Set(corpus.neverGloss.map((w) => w.toLowerCase()))

/** Strip the pinyin/annotation the service adds before comparing to labels. */
function bare(word: string): string {
  return word.replace(/\s*\([^)]*\)/g, "").trim()
}

interface Row {
  proficiency: number
  sampleIndex: number
  accepted: string[]
  candidateCount: number
  totalMs: number
}

const jobs: Array<() => Promise<void>> = []
const rows: Row[] = []
let failures = 0

for (let pass = 0; pass < repeat; pass++) {
  corpus.samples.forEach((sample, sampleIndex) => {
    for (const proficiency of levels) {
      jobs.push(async () => {
        try {
          const result = await glossService.gloss({
            conversationContext: sample.text,
            inputLanguage: sample.inputLanguage,
            outputLanguage: sample.outputLanguage,
            fluencyLevel: proficiency,
          })
          rows.push({
            proficiency,
            sampleIndex,
            accepted: result.words.map((w) => bare(w.word)),
            candidateCount: result.profiling.candidateCount,
            totalMs: result.profiling.totalMs,
          })
        } catch (error) {
          failures++
          console.error(`p=${proficiency} sample=${sampleIndex} failed:`, (error as Error).message)
        }
      })
    }
  })
}

let next = 0
async function worker(): Promise<void> {
  while (next < jobs.length) {
    const job = jobs[next++]
    await job()
  }
}

const started = Date.now()
await Promise.all(Array.from({length: concurrency}, worker))

const leakExamples = new Set<string>()

const summary = levels.map((proficiency) => {
  const tier = tierFor(proficiency, corpus.anchors)
  const knownRank = knownRankFor(proficiency)
  const mine = rows.filter((r) => r.proficiency === proficiency)
  let hits = 0
  let expected = 0
  let leaks = 0
  let noise = 0
  let accepted = 0
  let silent = 0
  let shouldBeSilent = 0
  let correctlySilent = 0
  const latencies: number[] = []

  for (const row of mine) {
    const sample = corpus.samples[row.sampleIndex]
    const want = sample.expect[tier]
    expected += want.length
    hits += want.filter((w) => row.accepted.includes(w)).length
    accepted += row.accepted.length
    if (row.accepted.length === 0) silent++
    if (want.length === 0) {
      shouldBeSilent++
      if (row.accepted.length === 0) correctlySilent++
    }
    noise += row.accepted.filter((w) => neverGloss.has(w.toLowerCase())).length
    leaks += row.accepted.filter((w) => {
      const rank = lookupRank(w, sample.inputLanguage)
      const leaked = rank != null && rank <= knownRank
      if (leaked) leakExamples.add(`p=${proficiency} ${w}:${rank} <= ${knownRank}`)
      return leaked
    }).length
    latencies.push(row.totalMs)
  }

  latencies.sort((a, b) => a - b)
  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`)
  return {
    proficiency,
    tier,
    knownRank,
    calls: mine.length,
    hitRate: `${hits}/${expected} = ${pct(hits, expected)}`,
    leaks,
    noise,
    wordsPerCall: mine.length ? (accepted / mine.length).toFixed(2) : "0",
    silent: `${silent}/${mine.length}`,
    correctlySilent: `${correctlySilent}/${shouldBeSilent}`,
    p50Ms: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p95Ms: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
  }
})

console.log(`\nmodel=${resolveModel()} samples=${corpus.samples.length} levels=${levels.join(",")} repeat=${repeat}`)
console.table(summary)
if (leakExamples.size > 0) {
  console.log("\nKnown-word leaks (must be empty)")
  for (const example of leakExamples) console.log(`  ${example}`)
}

console.log("\nPer-sample accepted words")
corpus.samples.forEach((sample, i) => {
  console.log(`\n${sample.text}`)
  for (const proficiency of levels) {
    const mine = rows.filter((r) => r.proficiency === proficiency && r.sampleIndex === i)
    const words = [...new Set(mine.flatMap((r) => r.accepted))]
    console.log(`  p=${String(proficiency).padStart(3)}  [${words.join(", ")}]`)
  }
})

console.log(
  `\ndone in ${Math.round((Date.now() - started) / 1000)}s, ${rows.length} calls, ${failures} failures`,
)
if (failures > 0) process.exit(1)
