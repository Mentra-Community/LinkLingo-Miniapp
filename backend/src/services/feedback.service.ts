/**
 * "Ask the analyst": the learner types a comment or question about what the
 * glasses just showed. We hand a smarter, slower model the last few
 * translations and the recent tape — what was heard, what was offered to the
 * gloss model, what it answered, the live prompt — and let it reply in plain
 * text. The exchange is kept in the feedback log for later prompt tuning.
 */

import {currentRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {FeedbackAnalysis, FeedbackRequest} from "../shared-types"
import {codeAgentGate, describeChange, startCodeChange} from "./code-agent"
import {feedbackLog} from "./feedback-log"
import {
  allowMockLlm,
  generateJson,
  LlmServiceError,
  resolveAnalystModel,
  resolveAnalystProvider,
  resolveApiKey,
  resolveModel,
} from "./gemini"
import {GLOSS_SYSTEM} from "./gloss.service"
import {digest, formatReviewEntry, reviewLog} from "./review-log"
import {formatTranscriptEntry, transcriptLog} from "./transcript-log"

const log = createLogger("feedback")

/** How far back the server-side tape is pulled for one comment. */
const TAPE_WINDOW_MS = 10 * 60_000
const MAX_TAPE_TRANSCRIPTS = 40
const MAX_TAPE_GLOSS_CALLS = 20
const MAX_NOTE_CHARS = 1000

const ANALYST_SYSTEM = `You are the engineer behind LinkLingo, a smart-glasses app for language learners. The learner hears live speech in the INPUT language and the glasses show up to 3 rows of "rare word -> translation in the OUTPUT language", plus optional caption lines of the raw transcript. The learner is now commenting on, or asking about, what they just saw.

How the pipeline works, in order:
1. The phone's speech recogniser produces final utterances (it may mistranscribe, split, or mislabel the language).
2. The phone skips an utterance whose dominant script is the OUTPUT language (the learner reads that natively). Only applies when the two languages use different scripts.
3. The backend tokenises the utterance, drops tokens the learner already knows (rank <= KNOWN in a frequency list), drops output-script tokens, and offers the remaining rare tokens to the gloss model as word:rank.
4. The live gloss model (named LIVE GLOSS MODEL in the user message; it is not you) runs the gloss prompt over the candidates and picks at most MAX words with translations. The backend rejects picks that are not candidates, untranslated (same script as input), recently shown, or known.
5. Rows sit on the glasses for ~25s in fixed slots: 3 word rows above 3 caption rows.

Reply to the learner directly, in the language they wrote in (keep quoted tape text, code and identifiers verbatim). Answer the question they actually asked. If they ask what someone said, who was speaking, or what a name or number referred to, reconstruct that from the tape in plain language. Diagnose a pipeline stage only when they ask why the glasses showed, skipped, or mistranslated something — and then quote the utterance, the candidate list, or the rejection reason that supports it. Never invent tape entries. If the tape does not contain the conversation, say so. Under 180 words, plain prose, no headings.

You cannot edit anything yourself. When the learner asks for the app to behave differently — a new feature, a changed setting, a fix for something that went wrong — also write "changeRequest": a self-contained instruction for an engineer who has the repository but not this conversation. Say what should change, where you think it lives (phone routing, backend candidate selection, gloss prompt, HUD layout), the evidence from the tape, and how to tell it worked. A coding agent receives it and ships it to the dev server. In "answer", say that the change has been sent to be built; never claim it is already live. For questions, explanations, or complaints that are not asking for a change, set "changeRequest" to "".

Return JSON only: {"answer": "...", "changeRequest": "..."}`

const ANALYST_SCHEMA = {
  type: "object",
  properties: {answer: {type: "string"}, changeRequest: {type: "string"}},
  required: ["answer", "changeRequest"],
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
    `LEARNER'S COMMENT:\n${req.note.trim()}`,
    "",
    `ROWS ON THE GLASSES RIGHT NOW:\n${rows(req.shownWords)}`,
    `LAST TRANSLATIONS SHOWN (phone memory):\n${rows(req.recentWords)}`,
    req.caption ? `CAPTION ON THE GLASSES:\n${req.caption}` : "",
    req.translation ? `TRANSLATION MODE TEXT:\n${req.original}\n→ ${req.translation}` : "",
    "",
    `LAST UTTERANCES HELD ON THE PHONE (~30s):\n${utterances}`,
    "",
    `SERVER TRANSCRIPT TAPE, last ${TAPE_WINDOW_MS / 60_000} min (disposition = why it did or did not go to the model; "would gloss" = candidates the filter offers):\n${tapeText || "(nothing recorded for this user)"}`,
    "",
    `SERVER GLOSS CALLS, last ${TAPE_WINDOW_MS / 60_000} min (heard → candidates → raw model answer → shown / dropped):\n${glossText || "(no model calls recorded for this user)"}`,
    "",
    `LIVE GLOSS MODEL: ${resolveModel()}`,
    `CURRENT GLOSS PROMPT (the system instruction that model runs under):\n"""\n${GLOSS_SYSTEM}\n"""`,
  ]
    .filter((line) => line !== "")
    .join("\n")
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

  let answer: string
  let changeRequest = ""
  let modelUsed = model
  if (!resolveApiKey() && allowMockLlm()) {
    answer = "Mock analyst: LINKLINGO_ALLOW_MOCK_LLM is set, so no model was consulted."
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
      provider: resolveAnalystProvider(),
    })
    try {
      const parsed = JSON.parse(result.text) as {answer?: unknown; changeRequest?: unknown}
      answer = String(parsed.answer ?? "").trim()
      changeRequest = String(parsed.changeRequest ?? "").trim()
    } catch (error) {
      metrics.increment("feedback_outcomes_total", {outcome: "unparseable"})
      log.error("analyst returned unparseable JSON", {raw: result.text.slice(0, 400), error})
      throw new LlmServiceError("Analyst returned malformed output", 500)
    }
    if (!answer) answer = "The analyst did not return an answer."
  }

  const analysis: FeedbackAnalysis = {id: "", model: modelUsed, answer, totalMs: Date.now() - started}

  const {note: _dropped, ...snapshot} = req
  const entry = feedbackLog.record({
    note,
    snapshot,
    tape: {transcripts: transcripts.length, glossCalls: glossCalls.length, windowMs: TAPE_WINDOW_MS},
    analysis,
  })
  analysis.id = entry.id

  if (changeRequest) {
    const gate = codeAgentGate(user)
    const change =
      gate === "ok"
        ? await startCodeChange({note, instruction: changeRequest, feedbackId: entry.id}, (done) =>
            feedbackLog.setChange(entry.id, done),
          )
        : undefined
    analysis.answer = `${answer}\n\n${describeChange(gate, change)}`
    analysis.change = change
    feedbackLog.setChange(entry.id, change)
    log.info("change requested", {id: entry.id, gate, status: change?.status, agentId: change?.agentId})
  }

  metrics.increment("feedback_outcomes_total", {outcome: "ok"})
  metrics.observe("feedback_duration", analysis.totalMs)
  log.info("feedback analysed", {id: entry.id, totalMs: analysis.totalMs, answerChars: answer.length})
  return analysis
}
