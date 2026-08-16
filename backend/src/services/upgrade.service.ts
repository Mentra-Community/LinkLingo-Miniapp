import type {UpgradeRequest, UpgradeResponse} from "../shared-types"
import {allowMockLlm, generateJson, resolveApiKey, resolveModel} from "./gemini"
import {annotateChinese, isChinese, languageIsChinese, languageWantsPinyin} from "./pinyin"

const UPGRADE_SYSTEM = `You suggest one useful "upgrade" word for a language learner — a word they are not using yet that would help in this conversation.

Rules:
- Return exactly one word in the INPUT (learning) language and a 1-3 word meaning in the OUTPUT (known) language.
- The upgrade word MUST NOT appear in the transcript or in RECENT.
- The meaning MUST NOT appear in the transcript or in RECENT.
- Fluency < 30: common everyday words. Fluency > 70: rarer, more precise words. Mid: intermediate vocabulary.
- Never suggest function words (the, a, it, 的, 了).
- Return JSON only: {"word":"...","meaning":"..."} or {"word":"","meaning":""} if nothing useful.

Examples:
Transcript: "quel exercice aimes-tu? Aimes-tu l'eau?" Input=French Output=English Fluency=25
→ {"word":"nager","meaning":"to swim"}

Transcript: "她连续三年赢得奥林匹克赛的金牌，真是太厉害了。" Input=Chinese Output=English Fluency=60
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
    if (!context) {
      return {
        profiling: {totalMs: Date.now() - started, model: this.model, candidateCount: 0},
      }
    }

    if (!resolveApiKey() && allowMockLlm()) {
      return {
        word: "practice",
        meaning: "practice",
        profiling: {totalMs: Date.now() - started, model: "mock", candidateCount: 0},
      }
    }

    const user = [
      `Input language (learning): ${body.inputLanguage}`,
      `Output language (known): ${body.outputLanguage}`,
      `Fluency: ${body.fluencyLevel}`,
      `Transcript: ${context.slice(-400)}`,
      `Recent: ${recent.join(", ") || "(none)"}`,
    ].join("\n")

    const result = await generateJson({
      system: UPGRADE_SYSTEM,
      user,
      maxOutputTokens: 64,
      responseSchema: UPGRADE_SCHEMA,
    })

    let parsed: {word?: string; meaning?: string} = {}
    try {
      parsed = JSON.parse(result.text) as typeof parsed
    } catch {
      parsed = {}
    }

    let word = (parsed.word ?? "").trim()
    let meaning = (parsed.meaning ?? "").trim()
    const contextLower = context.toLowerCase()
    if (
      !word ||
      !meaning ||
      word.toLowerCase() === meaning.toLowerCase() ||
      contextLower.includes(word.toLowerCase()) ||
      contextLower.includes(meaning.toLowerCase()) ||
      recent.includes(word.toLowerCase()) ||
      recent.includes(meaning.toLowerCase())
    ) {
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

    return {
      word,
      meaning,
      profiling: {
        totalMs: Date.now() - started,
        geminiMs: result.geminiMs,
        parseMs: result.parseMs,
        model: result.model,
        candidateCount: 0,
      },
    }
  }
}

export const upgradeService = new UpgradeService()
