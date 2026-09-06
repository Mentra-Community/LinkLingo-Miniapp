import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {UpgradeRequest, UpgradeResponse} from "../shared-types"
import {knownRankFor, lookupRank} from "./frequency"
import {allowMockLlm, generateJson, resolveApiKey, resolveModel} from "./gemini"
import {annotateChinese, isChinese, languageIsChinese, languageWantsPinyin} from "./pinyin"

const log = createLogger("upgrade")

/** An upgrade must sit above the learner's vocabulary but stay within reach. */
const UPGRADE_WINDOW_LOW = 1
const UPGRADE_WINDOW_HIGH = 3
const UPGRADE_TOO_HARD_MULTIPLE = 6

const UPGRADE_SYSTEM = `You suggest one useful "upgrade" word for a language learner — a word they are not using yet that would help in this conversation.

The learner knows roughly the KNOWN most common words of the input language, where KNOWN is a frequency rank (1 = most common word in the language).

Rules:
- Return exactly one word in the INPUT (learning) language and a 1-3 word meaning in the OUTPUT (known) language.
- Aim for a word whose own frequency rank falls in the TARGET range: rare enough to be new, common enough to be worth learning. Idioms and set phrases are welcome.
- The upgrade word MUST NOT appear in the transcript or in RECENT.
- The meaning MUST NOT appear in the transcript or in RECENT.
- Never suggest function words (the, a, it, 的, 了).
- Return JSON only: {"word":"...","meaning":"..."} or {"word":"","meaning":""} if nothing useful.

Examples:
Transcript: "quel exercice aimes-tu? Aimes-tu l'eau?" Input=French Output=English KNOWN=800 TARGET=800-2400
→ {"word":"nager","meaning":"to swim"}

Transcript: "她连续三年赢得奥林匹克赛的金牌，真是太厉害了。" Input=Chinese Output=English KNOWN=3137 TARGET=3137-9411
→ {"word":"天下无敌","meaning":"unbeatable everywhere"}`

const UPGRADE_SCHEMA = {
  type: "object",
  properties: {
    word: {type: "string"},
    meaning: {type: "string"},
  },
  required: ["word", "meaning"],
}

export class UpgradeService {
  readonly model = resolveModel()

  async upgrade(body: UpgradeRequest): Promise<UpgradeResponse> {
    const started = Date.now()
    const context = (body.conversationContext ?? "").trim()
    const recent = (body.recentUpgrades ?? []).map((w) => w.toLowerCase())
    const knownRank = knownRankFor(body.fluencyLevel ?? 50)
    const call = log.child({
      in: body.inputLanguage,
      out: body.outputLanguage,
      fluency: body.fluencyLevel,
      knownRank,
    })
    metrics.increment("upgrade_requests_total", {in: body.inputLanguage, out: body.outputLanguage})

    if (!context) {
      metrics.increment("upgrade_outcomes_total", {outcome: "empty_context"})
      call.info("upgrade skipped", {reason: "empty_context"})
      return {
        profiling: {totalMs: Date.now() - started, model: this.model, candidateCount: 0},
      }
    }

    if (!resolveApiKey() && allowMockLlm()) {
      metrics.increment("upgrade_outcomes_total", {outcome: "mock"})
      call.warn("serving mock upgrade: no API key and mock mode enabled")
      return {
        word: "practice",
        meaning: "practice",
        profiling: {totalMs: Date.now() - started, model: "mock", candidateCount: 0},
      }
    }

    const user = [
      `Input language (learning): ${body.inputLanguage}`,
      `Output language (known): ${body.outputLanguage}`,
      `KNOWN=${knownRank} TARGET=${knownRank * UPGRADE_WINDOW_LOW}-${knownRank * UPGRADE_WINDOW_HIGH}`,
      `Transcript: ${context.slice(-400)}`,
      `Recent: ${recent.join(", ") || "(none)"}`,
    ].join("\n")

    const result = await generateJson({
      system: UPGRADE_SYSTEM,
      user,
      maxOutputTokens: 64,
      responseSchema: UPGRADE_SCHEMA,
      operation: "upgrade",
    })

    let parsed: {word?: string; meaning?: string} = {}
    try {
      parsed = JSON.parse(result.text) as typeof parsed
    } catch (error) {
      parsed = {}
      metrics.increment("upgrade_parse_failures_total")
      call.error("model returned unparseable JSON", {
        truncated: result.truncated,
        finishReason: result.finishReason,
        responseChars: result.text.length,
        error,
      })
    }

    let word = (parsed.word ?? "").trim()
    let meaning = (parsed.meaning ?? "").trim()
    const contextLower = context.toLowerCase()
    // Words the dictionary has never seen are kept: multi-word idioms like
    // 天下无敌 are legitimate upgrades and simply have no rank of their own.
    const wordRank = word ? lookupRank(word, body.inputLanguage) : null

    // These filters used to collapse into one boolean, so a suggestion could be
    // dropped for any of six reasons with no way to tell which.
    const reject = !word
      ? "missing_word"
      : !meaning
        ? "missing_meaning"
        : word.toLowerCase() === meaning.toLowerCase()
          ? "echo"
          : contextLower.includes(word.toLowerCase())
            ? "word_in_context"
            : contextLower.includes(meaning.toLowerCase())
              ? "meaning_in_context"
              : recent.includes(word.toLowerCase())
                ? "word_recent"
                : recent.includes(meaning.toLowerCase())
                  ? "meaning_recent"
                  : wordRank != null && wordRank <= knownRank
                    ? "too_easy"
                    : wordRank != null && wordRank > knownRank * UPGRADE_TOO_HARD_MULTIPLE
                      ? "too_hard"
                      : null

    if (reject) {
      metrics.increment("upgrade_outcomes_total", {outcome: "rejected"})
      metrics.increment("upgrade_rejected_total", {reason: reject})
      call.info("upgrade rejected", {
        reason: reject,
        word: word || undefined,
        wordRank: wordRank ?? undefined,
        geminiMs: result.geminiMs,
        totalMs: Date.now() - started,
      })
      return {
        profiling: {
          totalMs: Date.now() - started,
          geminiMs: result.geminiMs,
          parseMs: result.parseMs,
          model: result.model,
          candidateCount: 0,
        },
      }
    }

    if (isChinese(word) && languageIsChinese(body.inputLanguage)) {
      word = annotateChinese(word, languageWantsPinyin(body.inputLanguage))
    }
    if (isChinese(meaning) && languageIsChinese(body.outputLanguage)) {
      meaning = annotateChinese(meaning, languageWantsPinyin(body.outputLanguage))
    }

    const totalMs = Date.now() - started
    metrics.increment("upgrade_outcomes_total", {outcome: "suggested"})
    metrics.observe("upgrade_total_duration", totalMs)
    call.info("upgrade suggested", {
      word,
      wordRank: wordRank ?? undefined,
      totalMs,
      geminiMs: result.geminiMs,
      totalTokens: result.usage.totalTokens,
    })

    return {
      word,
      meaning,
      profiling: {
        totalMs,
        geminiMs: result.geminiMs,
        parseMs: result.parseMs,
        model: result.model,
        candidateCount: 0,
      },
    }
  }
}

export const upgradeService = new UpgradeService()
