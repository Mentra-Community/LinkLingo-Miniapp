/**
 * "Ask the analyst": the learner saw something wrong on the glasses and typed
 * a sentence about it. We hand a smarter, slower model everything the pipeline
 * knows about the last few minutes — the phone's snapshot, the transcript tape,
 * the gloss calls with their candidates and rejections, and the live prompt —
 * and ask it to name the failing stage and propose a fix. The verdict goes back
 * to the WebView and into the feedback log for the next prompt-tuning pass.
 */

import {currentRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {FeedbackAnalysis, FeedbackCause, FeedbackRequest} from "../shared-types"
import {feedbackLog} from "./feedback-log"
import {allowMockLlm, generateJson, LlmServiceError, resolveApiKey, resolveAnalystModel} from "./gemini"
import {GLOSS_SYSTEM} from "./gloss.service"
import {digest, formatReviewEntry, reviewLog} from "./review-log"
import {formatTranscriptEntry, transcriptLog} from "./transcript-log"

const log = createLogger("feedback")

/** How far back the server-side tape is pulled for one complaint. */
const TAPE_WINDOW_MS = 10 * 60_000
const MAX_TAPE_TRANSCRIPTS = 40
const MAX_TAPE_GLOSS_CALLS = 20
const MAX_NOTE_CHARS = 1000

const CAUSES: FeedbackCause[] = [
  "asr",
  "language_guard",
  "candidate_filter",
  "prompt",
  "model",
  "display",
  "no_problem",
  "unknown",
]

const ANALYST_SYSTEM = `You are the engineer on call for LinkLingo, a smart-glasses app for language learners. The learner hears live speech in the INPUT language and the glasses show up to 3 rows of "rare word -> translation in the OUTPUT language", plus optional caption lines of the raw transcript. The learner has just flagged a problem and you must diagnose it from the evidence.

The pipeline, in order:
1. asr — the phone's speech recogniser produces final utterances (may mistranscribe, split, or mislabel the language).
2. language_guard — the phone skips an utterance whose dominant script is the OUTPUT language (the learner reads that natively). Only applies when the two languages use different scripts.
3. candidate_filter — the backend tokenises the utterance, drops tokens the learner already knows (rank <= KNOWN in a frequency list), drops output-script tokens, and offers the remaining rare tokens to the gloss model as word:rank.
4. prompt / model — Gemini Flash-Lite is given the gloss prompt (below) and the candidates, and picks at most MAX words with translations. The backend then rejects picks that are not candidates, untranslated (same script as input), recently shown, or known.
5. display — rows sit on the glasses for ~25s in fixed slots; 3 word rows above 3 caption rows.

Your job:
- Decide which stage most plausibly caused what the learner describes. Use "no_problem" when the behaviour was correct and explain why; use "unknown" when the evidence genuinely cannot decide.
- Cite concrete evidence from the tape: quote the utterance, the candidate list, the model's raw answer, the rejection reason. Do not invent entries that are not in the evidence.
- Propose one concrete, minimal fix an engineer could make today. If the cause is the prompt, write the exact sentence(s) to add or change in suggestedPromptChange; otherwise leave it empty.
- Write for the learner-developer reading on a phone: diagnosis under 80 words, plain language, no headings.
- Answer in the same language the learner wrote the note in, except keep code, identifiers and quoted tape text verbatim.
- Return JSON only.`

const ANALYST_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: {type: "string"},
    likelyCause: {type: "string", enum: CAUSES},
    evidence: {type: "array", items: {type: "string"}},
    suggestedFix: {type: "string"},
    suggestedPromptChange: {type: "string"},
  },
  required: ["diagnosis", "likelyCause", "evidence", "suggestedFix"],
}

interface AnalystAnswer {
  diagnosis: string
  likelyCause: string
  evidence: string[]
  suggestedFix: string
  suggestedPromptChange?: string
}

type ThinkingLevel = "minimal" | "low" | "medium" | "high"

/** How hard the analyst thinks. Medium keeps a phone-side wait around ten seconds; high is available when depth matters more. */
function resolveAnalystThinking(): ThinkingLevel {
  const raw = process.env.GEMINI_ANALYST_THINKING
  return raw === "minimal" || raw === "low" || raw === "medium" || raw === "high" ? raw : "medium"
}

function fmtTime(at: number): string {
  return new Date(at).toISOString().slice(11, 19)
}

function buildUserPrompt(req: FeedbackRequest, tapeText: string, glossText: string, now: number): string {
  const s = req.settings
  const rows = (ws: FeedbackRequest["shownWords"]) =>
    ws.length === 0
      ? "(none)"
      : ws.map((w) => `${fmtTime(w.at)} ${w.word} -> ${w.translation}${w.isUpgrade ? " (upgrade)" : ""}`).join("\n")
  const utterances =
    req.recentUtterances.length === 0
      ? "(none)"
      : req.recentUtterances.map((u) => `${fmtTime(u.at)} [${u.language ?? "?"}] ${u.text}`).join("\n")

  return [
    `NOW: ${new Date(now).toISOString()}`,
    `SETTINGS: input=${s.inputLanguage} output=${s.outputLanguage} proficiency=${s.proficiency}/100 mode=${s.mode}`,
    "",
    `LEARNER'S NOTE:\n${req.note.trim()}`,
    "",
    `ROWS ON THE GLASSES WHEN THEY WROTE IT:\n${rows(req.shownWords)}`,
    `ALL WORDS SHOWN RECENTLY (phone memory):\n${rows(req.recentWords)}`,
    req.caption ? `CAPTION ON THE GLASSES:\n${req.caption}` : "",
    req.translation ? `TRANSLATION MODE TEXT:\n${req.original}\n→ ${req.translation}` : "",
    "",
    `LAST UTTERANCES HELD ON THE PHONE (~30s):\n${utterances}`,
    "",
    `SERVER TRANSCRIPT TAPE, last ${TAPE_WINDOW_MS / 60_000} min (disposition = why it did or did not go to the model; "would gloss" = candidates the filter offers):\n${tapeText || "(nothing recorded for this user)"}`,
    "",
    `SERVER GLOSS CALLS, last ${TAPE_WINDOW_MS / 60_000} min (heard → candidates → raw model answer → shown / dropped):\n${glossText || "(no model calls recorded for this user)"}`,
    "",
    `CURRENT GLOSS PROMPT (the system instruction Flash-Lite runs under):\n"""\n${GLOSS_SYSTEM}\n"""`,
  ]
    .filter((line) => line !== "")
    .join("\n")
}

function mockAnalysis(): AnalystAnswer {
  return {
    diagnosis: "Mock analyst: LINKLINGO_ALLOW_MOCK_LLM is set, so no model was consulted.",
    likelyCause: "unknown",
    evidence: ["mock mode"],
    suggestedFix: "Run against a real GEMINI_API_KEY to get a diagnosis.",
  }
}

export async function analyseFeedback(req: FeedbackRequest, now = Date.now()): Promise<FeedbackAnalysis> {
  const started = now
  const note = req.note.trim().slice(0, MAX_NOTE_CHARS)
  const user = currentRequestContext()?.userId
  const userDigest = user ? digest(user) : undefined
  const since = now - TAPE_WINDOW_MS

  // The tape is per pod and keyed by user digest; a user with no digest (no
  // auth context) gets the whole pod's recent tape, which is only reachable
  // in tests.
  const transcripts = transcriptLog.list({since, user: userDigest, limit: MAX_TAPE_TRANSCRIPTS}, now)
  const glossCalls = reviewLog.list({since, user: userDigest, limit: MAX_TAPE_GLOSS_CALLS}, now)
  const tapeText = transcripts.map(formatTranscriptEntry).join("\n")
  const glossText = glossCalls.map(formatReviewEntry).join("\n\n")

  const model = resolveAnalystModel()
  const userPrompt = buildUserPrompt({...req, note}, tapeText, glossText, now)
  log.info("feedback analysis requested", {
    model,
    noteChars: note.length,
    transcripts: transcripts.length,
    glossCalls: glossCalls.length,
    promptChars: userPrompt.length,
  })

  let answer: AnalystAnswer
  let modelUsed = model
  if (!resolveApiKey() && allowMockLlm()) {
    answer = mockAnalysis()
    modelUsed = "mock"
  } else {
    const result = await generateJson({
      system: ANALYST_SYSTEM,
      user: userPrompt,
      // Gemini 3 bills thinking against maxOutputTokens; at 2048 the model
      // hit MAX_TOKENS with 69 tokens of actual answer. The visible JSON is
      // a few hundred tokens, the rest is headroom for reasoning.
      maxOutputTokens: 16_384,
      responseSchema: ANALYST_SCHEMA,
      operation: "feedback",
      model,
      thinkingLevel: resolveAnalystThinking(),
    })
    try {
      answer = JSON.parse(result.text) as AnalystAnswer
    } catch (error) {
      metrics.increment("feedback_outcomes_total", {outcome: "unparseable"})
      log.error("analyst returned unparseable JSON", {raw: result.text.slice(0, 400), error})
      throw new LlmServiceError("Analyst returned malformed output", 500)
    }
  }

  const cause = (CAUSES as string[]).includes(answer.likelyCause) ? (answer.likelyCause as FeedbackCause) : "unknown"
  const analysis: FeedbackAnalysis = {
    id: "",
    model: modelUsed,
    diagnosis: (answer.diagnosis ?? "").trim() || "The analyst did not return a diagnosis.",
    likelyCause: cause,
    evidence: Array.isArray(answer.evidence) ? answer.evidence.map(String).filter(Boolean).slice(0, 8) : [],
    suggestedFix: (answer.suggestedFix ?? "").trim(),
    suggestedPromptChange: answer.suggestedPromptChange?.trim() || undefined,
    totalMs: Date.now() - started,
  }

  const {note: _dropped, ...snapshot} = req
  const entry = feedbackLog.record({
    note,
    snapshot,
    tape: {transcripts: transcripts.length, glossCalls: glossCalls.length, windowMs: TAPE_WINDOW_MS},
    analysis,
  })
  analysis.id = entry.id
  entry.analysis.id = entry.id

  metrics.increment("feedback_outcomes_total", {outcome: "ok", cause})
  metrics.observe("feedback_duration", analysis.totalMs)
  log.info("feedback analysed", {id: entry.id, cause, totalMs: analysis.totalMs})
  return analysis
}
