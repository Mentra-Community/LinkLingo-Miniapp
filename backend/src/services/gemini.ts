import {createHash} from "node:crypto"

export type LlmErrorStatus = 400 | 429 | 500 | 503

export class LlmServiceError extends Error {
  constructor(
    message: string,
    readonly status: LlmErrorStatus,
    readonly upstreamStatus?: number,
  ) {
    super(message)
    this.name = "LlmServiceError"
  }
}

export interface GeminiCallOptions {
  system: string
  user: string
  maxOutputTokens: number
  responseSchema: Record<string, unknown>
}

export interface GeminiCallResult {
  text: string
  geminiMs: number
  parseMs: number
  model: string
}

export function resolveModel(): string {
  return process.env.GEMINI_MODEL ?? process.env.LLM_MODEL ?? "gemini-3.5-flash-lite"
}

export function resolveApiKey(): string | undefined {
  return (
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY
  )
}

export function resolveApiKeySource(): string | undefined {
  if (process.env.GEMINI_API_KEY) return "GEMINI_API_KEY"
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) return "GOOGLE_GENERATIVE_AI_API_KEY"
  if (process.env.GOOGLE_API_KEY) return "GOOGLE_API_KEY"
  return undefined
}

/**
 * Short one-way digest of the configured key. Lets an operator confirm which
 * key a running pod picked up without exposing the key itself.
 */
export function apiKeyFingerprint(): string | undefined {
  const key = resolveApiKey()
  if (!key) return undefined
  return createHash("sha256").update(key).digest("hex").slice(0, 8)
}

export function allowMockLlm(): boolean {
  return process.env.LINKLINGO_ALLOW_MOCK_LLM === "true"
}

/**
 * Upstream Gemini failures are not all the same class of problem, and calling
 * every one of them a 500 hides quota exhaustion and bad keys behind a generic
 * server error.
 */
function classifyUpstream(status: number): LlmErrorStatus {
  if (status === 429) return 429
  if (status === 401 || status === 403) return 503
  if (status >= 500) return 503
  return 400
}

export async function generateJson(opts: GeminiCallOptions): Promise<GeminiCallResult> {
  const apiKey = resolveApiKey()
  const model = resolveModel()
  if (!apiKey) {
    throw new LlmServiceError("GEMINI_API_KEY is required", 503)
  }

  const started = Date.now()
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {parts: [{text: opts.system}]},
        contents: [{role: "user", parts: [{text: opts.user}]}],
        generationConfig: {
          maxOutputTokens: opts.maxOutputTokens,
          temperature: 0.3,
          responseMimeType: "application/json",
          responseSchema: opts.responseSchema,
        },
      }),
    },
  )
  const geminiMs = Date.now() - started
  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new LlmServiceError(
      `Gemini ${response.status} (model=${model} key=${apiKeyFingerprint()}): ${errorText.slice(0, 400)}`,
      classifyUpstream(response.status),
      response.status,
    )
  }

  const parseStarted = Date.now()
  const data = (await response.json()) as {
    candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "{}"
  return {text, geminiMs, parseMs: Date.now() - parseStarted, model}
}
