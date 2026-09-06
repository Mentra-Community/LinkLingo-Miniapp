import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {GlossRequest, GlossResponse, GlossedWord} from "../shared-types"
import {candidateWords, knownRankFor, lookupRank, type WordCandidate} from "./frequency"
import {allowMockLlm, generateJson, LlmServiceError, resolveApiKey, resolveModel} from "./gemini"
import {annotateChinese, isChinese, languageIsChinese, languageWantsPinyin} from "./pinyin"

const log = createLogger("gloss")

/** Why a model-proposed word did not make it to the glasses. */
type RejectReason = "empty" | "echo" | "recent" | "not_candidate" | "known"

const GLOSS_SYSTEM = `You gloss unfamiliar words for a language learner listening to live speech through smart glasses.

The learner already knows roughly the KNOWN most common words of the input language. Each candidate is written as word:rank, where rank is its frequency rank in that language (1 = most common). Every candidate is already rarer than the learner's vocabulary, so the higher the rank, the less likely they know it.

Rules:
- Pick at most MAX candidates, choosing the ones with the highest learning value: content words (nouns, verbs, adjectives, set phrases) the learner most plausibly cannot follow.
- Prefer higher-rank candidates, but skip proper names, numbers, mistranscriptions and fragments however rare they look.
- Pick ONLY from CANDIDATES. Never invent, split or reshape a word.
- Translate each pick into the output language in 1-4 words, accurate for this context.
- Bidirectional: if a candidate is already in the output language, translate it into the input language.
- Never re-gloss a word in RECENT.
- Returning {"words":[]} is a good answer when nothing is worth glossing, which is common for fluent learners.
- Return JSON only: {"words":[{"word":"...","translation":"..."}]}

Examples:
KNOWN=444 MAX=3  Candidates: 博物馆:4156, 参观:3649, 餐厅:1700  Input=Chinese Output=English
→ {"words":[{"word":"博物馆","translation":"museum"},{"word":"参观","translation":"to visit"},{"word":"餐厅","translation":"restaurant"}]}

KNOWN=5641 MAX=2  Candidates: ramifications:21455, socioeconomic:38210, thesis:5980  Input=English Output=Chinese
→ {"words":[{"word":"socioeconomic","translation":"社会经济的"},{"word":"ramifications","translation":"影响"}]}

KNOWN=10144 MAX=2  Candidates: Tuesday:11450, subway:9800  Input=English Output=Chinese
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

function formatCandidates(candidates: WordCandidate[]): string {
  if (candidates.length === 0) return "(none)"
  return candidates.map((c) => `${c.word}:${c.rank}`).join(", ")
}

/**
 * How many words the HUD may show at once. Beginners need most of an utterance
 * decoded; advanced learners need the one word they missed. A budget of 1 at the
 * top end measured worse than 2 (38% vs 50% recall on the eval corpus) because
 * the model spent its single pick on the rarest word rather than the useful one.
 */
function pickBudget(proficiency: number): number {
  return proficiency < 34 ? 3 : 2
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
    const proficiency = body.fluencyLevel ?? 50
    const knownRank = knownRankFor(proficiency)
    const maxWords = pickBudget(proficiency)
    const call = log.child({
      in: body.inputLanguage,
      out: body.outputLanguage,
      fluency: proficiency,
      knownRank,
    })
    const selectStarted = Date.now()
    const candidates = context ? candidateWords(context, body.inputLanguage, recent, knownRank) : []
    const selectMs = Date.now() - selectStarted

    metrics.increment("gloss_requests_total", {
      in: body.inputLanguage,
      out: body.outputLanguage,
    })
    metrics.observe("gloss_candidate_selection_duration", selectMs)
    call.debug("candidates selected", {
      contextChars: context.length,
      recentCount: recent.length,
      candidateCount: candidates.length,
      selectMs,
      topCandidates: candidates.slice(0, 5).map((c) => `${c.word}:${c.rank}`).join(","),
    })

    if (!context || candidates.length === 0) {
      metrics.increment("gloss_outcomes_total", {outcome: context ? "no_candidates" : "empty_context"})
      call.info("gloss skipped", {
        reason: context ? "no_candidates" : "empty_context",
        contextChars: context.length,
      })
      return {
        words: [],
        profiling: {
          totalMs: Date.now() - started,
          model: this.model,
          candidateCount: candidates.length,
          knownRank,
        },
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
          knownRank,
        },
      }
    }

    const user = [
      `Input language: ${body.inputLanguage}`,
      `Output language: ${body.outputLanguage}`,
      `KNOWN=${knownRank} MAX=${maxWords}`,
      `Context: ${context.slice(-400)}`,
      `Candidates: ${formatCandidates(candidates)}`,
      `Recent: ${recent.join(", ") || "(none)"}`,
    ].join("\n")

    const result = await generateJson({
      system: GLOSS_SYSTEM,
      user,
      maxOutputTokens: 192,
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
      // Candidate selection already applied the rank cut, so this only fires
      // when the model reshapes a word into a more common form. Dropping it
      // here is what keeps "hello" off an advanced learner's HUD.
      const rank = lookupRank(bare, body.inputLanguage)
      if (rank != null && rank <= knownRank) {
        reject("known")
        continue
      }
      words.push(annotatePair(word, translation, body.inputLanguage, body.outputLanguage))
      if (words.length >= maxWords) break
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
        knownRank,
      },
    }
  }
}

export const glossService = new GlossService()
export {LlmServiceError}
