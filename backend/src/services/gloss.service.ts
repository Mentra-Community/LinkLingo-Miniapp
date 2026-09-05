import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {GlossRequest, GlossResponse, GlossedWord} from "../shared-types"
import {candidateWords, fluencyThreshold} from "./frequency"
import {allowMockLlm, generateJson, LlmServiceError, resolveApiKey, resolveModel} from "./gemini"
import {annotateChinese, isChinese, languageIsChinese, languageWantsPinyin} from "./pinyin"

const log = createLogger("gloss")

/** Why a model-proposed word did not make it to the glasses. */
type RejectReason = "empty" | "echo" | "recent" | "not_candidate"

const GLOSS_SYSTEM = `You help a language learner by glossing unfamiliar words from live speech.

Rules:
- Pick 0 to 2 words from the CANDIDATE list only. Never invent words that are not candidates.
- Translate each picked word into the output language. Keep translations short (1-4 words) and accurate.
- Scale density with fluency: 0-50 pick ~1 word per short utterance; 50-75 pick only if a candidate is clearly hard; >75 pick only very rare words.
- Never gloss function words, greetings, or mistranscriptions (3-letter Latin fragments, nonsense).
- Never re-gloss a word in RECENT.
- Bidirectional: if a candidate is already in the output language, translate it into the input language.
- Return JSON only: {"words":[{"word":"...","translation":"..."}]}
- If nothing is worth glossing, return {"words":[]}.

Examples:
Candidates: train:12.4, fruit stand:18.1  Input=English Output=Chinese Fluency=33
→ {"words":[{"word":"train","translation":"火车"},{"word":"fruit stand","translation":"水果摊"}]}

Candidates: студент:9.2, биология:14.0  Input=Russian Output=English Fluency=40
→ {"words":[{"word":"студент","translation":"student"}]}

Candidates: hello:0.4  Input=English Output=Spanish Fluency=20
→ {"words":[]}`

const GLOSS_SCHEMA = {
  type: "object",
  properties: {
    words: {
      type: "array",
      items: {
        type: "object",
        properties: {
          word: {type: "string"},
          translation: {type: "string"},
        },
        required: ["word", "translation"],
      },
    },
  },
  required: ["words"],
}

function formatCandidates(candidates: {word: string; percentile: number}[]): string {
  if (candidates.length === 0) return "(none)"
  return candidates.slice(0, 12).map((c) => `${c.word}:${c.percentile}`).join(", ")
}

function annotatePair(word: string, translation: string, inputLang: string, outputLang: string): GlossedWord {
  const inPinyin = languageWantsPinyin(inputLang)
  const outPinyin = languageWantsPinyin(outputLang)
  const inChinese = languageIsChinese(inputLang)
  const outChinese = languageIsChinese(outputLang)
  let processedWord = word
  let processedTranslation = translation
  if (isChinese(word) && inChinese) processedWord = annotateChinese(word, inPinyin)
  if (isChinese(translation) && outChinese) processedTranslation = annotateChinese(translation, outPinyin)
  return {word: processedWord, translation: processedTranslation}
}

export class GlossService {
  readonly model = resolveModel()

  async gloss(body: GlossRequest): Promise<GlossResponse> {
    const started = Date.now()
    const context = (body.conversationContext ?? "").trim()
    const recent = body.recentWords ?? []
    const threshold = fluencyThreshold(body.fluencyLevel ?? 50)
    const call = log.child({
      in: body.inputLanguage,
      out: body.outputLanguage,
      fluency: body.fluencyLevel,
    })
    const selectStarted = Date.now()
    const candidates = context ? candidateWords(context, body.inputLanguage, recent, threshold) : []
    const selectMs = Date.now() - selectStarted

    metrics.increment("gloss_requests_total", {
      in: body.inputLanguage,
      out: body.outputLanguage,
    })
    metrics.observe("gloss_candidate_selection_duration", selectMs)
    call.debug("candidates selected", {
      contextChars: context.length,
      recentCount: recent.length,
      threshold,
      candidateCount: candidates.length,
      selectMs,
      topCandidates: candidates.slice(0, 5).map((c) => `${c.word}:${c.percentile}`).join(","),
    })

    if (!context || candidates.length === 0) {
      metrics.increment("gloss_outcomes_total", {outcome: context ? "no_candidates" : "empty_context"})
      call.info("gloss skipped", {
        reason: context ? "no_candidates" : "empty_context",
        contextChars: context.length,
        threshold,
      })
      return {
        words: [],
        profiling: {totalMs: Date.now() - started, model: this.model, candidateCount: candidates.length},
      }
    }

    if (!resolveApiKey() && allowMockLlm()) {
      const first = candidates[0]
      metrics.increment("gloss_outcomes_total", {outcome: "mock"})
      call.warn("serving mock gloss: no API key and mock mode enabled")
      return {
        words: [annotatePair(first.word, first.word, body.inputLanguage, body.outputLanguage)],
        profiling: {
          totalMs: Date.now() - started,
          model: "mock",
          candidateCount: candidates.length,
        },
      }
    }

    const user = [
      `Input language: ${body.inputLanguage}`,
      `Output language: ${body.outputLanguage}`,
      `Fluency: ${body.fluencyLevel}`,
      `Context: ${context.slice(-400)}`,
      `Candidates: ${formatCandidates(candidates)}`,
      `Recent: ${recent.join(", ") || "(none)"}`,
    ].join("\n")

    const result = await generateJson({
      system: GLOSS_SYSTEM,
      user,
      maxOutputTokens: 128,
      responseSchema: GLOSS_SCHEMA,
      operation: "gloss",
    })

    let parsed: {words?: Array<{word?: string; translation?: string}>} = {}
    let parseFailed = false
    try {
      parsed = JSON.parse(result.text) as typeof parsed
    } catch (error) {
      parseFailed = true
      parsed = {words: []}
      metrics.increment("gloss_parse_failures_total")
      call.error("model returned unparseable JSON", {
        truncated: result.truncated,
        finishReason: result.finishReason,
        responseChars: result.text.length,
        error,
      })
    }

    const recentSet = new Set(recent.map((w) => w.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()))
    const candidateSet = new Set(candidates.map((c) => c.word.toLowerCase()))
    const words: GlossedWord[] = []
    const rejected: Array<{word: string; reason: RejectReason}> = []
    const proposed = parsed.words ?? []

    for (const item of proposed) {
      const word = (item.word ?? "").trim()
      const translation = (item.translation ?? "").trim()
      const reject = (reason: RejectReason) => {
        rejected.push({word: word || "(blank)", reason})
        metrics.increment("gloss_word_rejected_total", {reason})
      }
      if (!word || !translation) {
        reject("empty")
        continue
      }
      if (word.toLowerCase() === translation.toLowerCase()) {
        reject("echo")
        continue
      }
      const bare = word.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()
      if (recentSet.has(bare)) {
        reject("recent")
        continue
      }
      if (!candidateSet.has(bare) && !candidateSet.has(word.toLowerCase())) {
        // The model invented a word outside the candidate list; the prompt
        // forbids this, so a rising count here means prompt drift.
        reject("not_candidate")
        continue
      }
      words.push(annotatePair(word, translation, body.inputLanguage, body.outputLanguage))
      if (words.length >= 2) break
    }

    const totalMs = Date.now() - started
    metrics.observe("gloss_total_duration", totalMs)
    metrics.increment("gloss_outcomes_total", {
      outcome: parseFailed ? "parse_failed" : words.length > 0 ? "words" : "no_words",
    })
    metrics.increment("gloss_words_emitted_total", {}, words.length)

    call.info("gloss complete", {
      totalMs,
      geminiMs: result.geminiMs,
      candidateCount: candidates.length,
      proposedCount: proposed.length,
      acceptedCount: words.length,
      rejectedCount: rejected.length,
      rejected: rejected.length > 0 ? rejected.map((r) => `${r.word}:${r.reason}`).join(",") : undefined,
      accepted: words.length > 0 ? words.map((w) => w.word).join(",") : undefined,
      totalTokens: result.usage.totalTokens,
    })

    return {
      words,
      profiling: {
        totalMs,
        geminiMs: result.geminiMs,
        parseMs: result.parseMs,
        model: result.model,
        candidateCount: candidates.length,
      },
    }
  }
}

export const glossService = new GlossService()
export {LlmServiceError}
