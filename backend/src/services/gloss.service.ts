import type {GlossRequest, GlossResponse, GlossedWord} from "../shared-types"
import {candidateWords, fluencyThreshold} from "./frequency"
import {allowMockLlm, generateJson, LlmServiceError, resolveApiKey, resolveModel} from "./gemini"
import {annotateChinese, isChinese, languageIsChinese, languageWantsPinyin} from "./pinyin"

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
    const candidates = context ? candidateWords(context, body.inputLanguage, recent, threshold) : []

    if (!context || candidates.length === 0) {
      return {
        words: [],
        profiling: {totalMs: Date.now() - started, model: this.model, candidateCount: candidates.length},
      }
    }

    if (!resolveApiKey() && allowMockLlm()) {
      const first = candidates[0]
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
    })

    let parsed: {words?: Array<{word?: string; translation?: string}>} = {}
    try {
      parsed = JSON.parse(result.text) as typeof parsed
    } catch {
      parsed = {words: []}
    }

    const recentSet = new Set(recent.map((w) => w.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()))
    const candidateSet = new Set(candidates.map((c) => c.word.toLowerCase()))
    const words: GlossedWord[] = []
    for (const item of parsed.words ?? []) {
      const word = (item.word ?? "").trim()
      const translation = (item.translation ?? "").trim()
      if (!word || !translation) continue
      if (word.toLowerCase() === translation.toLowerCase()) continue
      const bare = word.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim()
      if (recentSet.has(bare)) continue
      if (!candidateSet.has(bare) && !candidateSet.has(word.toLowerCase())) continue
      words.push(annotatePair(word, translation, body.inputLanguage, body.outputLanguage))
      if (words.length >= 2) break
    }

    return {
      words,
      profiling: {
        totalMs: Date.now() - started,
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
