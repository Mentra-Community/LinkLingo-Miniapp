export class LlmServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 | 503,
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

export function allowMockLlm(): boolean {
  return process.env.LINKLINGO_ALLOW_MOCK_LLM === "true"
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
          thinkingConfig: {thinkingBudget: 0},
        },
      }),
    },
  )
  const geminiMs = Date.now() - started
  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    throw new LlmServiceError(`Gemini ${response.status}: ${errorText.slice(0, 240)}`, 500)
  }

  const parseStarted = Date.now()
  const data = (await response.json()) as {
    candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "{}"
  return {text, geminiMs, parseMs: Date.now() - parseStarted, model}
}
