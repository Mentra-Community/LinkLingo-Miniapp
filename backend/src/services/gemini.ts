import {createHash} from "node:crypto"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"

const log = createLogger("gemini")

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
  /** Names the caller so logs and metrics separate gloss traffic from upgrade traffic. */
  operation: string
}

export interface GeminiUsage {
  promptTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface GeminiCallResult {
  text: string
  geminiMs: number
  parseMs: number
  model: string
  finishReason?: string
  usage: GeminiUsage
  truncated: boolean
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

interface GeminiResponseBody {
  candidates?: Array<{
    content?: {parts?: Array<{text?: string}>}
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

export async function generateJson(opts: GeminiCallOptions): Promise<GeminiCallResult> {
  const apiKey = resolveApiKey()
  const model = resolveModel()
  const call = log.child({op: opts.operation, model})

  if (!apiKey) {
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "no_key"})
    call.error("no API key configured", {checked: "GEMINI_API_KEY,GOOGLE_GENERATIVE_AI_API_KEY,GOOGLE_API_KEY"})
    throw new LlmServiceError("GEMINI_API_KEY is required", 503)
  }

  call.debug("llm request", {
    promptChars: opts.system.length + opts.user.length,
    maxOutputTokens: opts.maxOutputTokens,
    keyFingerprint: apiKeyFingerprint(),
  })

  const started = Date.now()
  let response: Response
  try {
    response = await fetch(
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
  } catch (error) {
    const geminiMs = Date.now() - started
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "transport_error"})
    metrics.observe("llm_call_duration", geminiMs, {op: opts.operation})
    call.error("llm transport failure", {geminiMs, error})
    throw new LlmServiceError(`Gemini unreachable: ${(error as Error).message}`, 503)
  }

  const geminiMs = Date.now() - started
  metrics.observe("llm_call_duration", geminiMs, {op: opts.operation})

  if (!response.ok) {
    const errorText = await response.text().catch(() => "")
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "upstream_error"})
    metrics.increment("llm_upstream_status_total", {op: opts.operation, status: response.status})
    call.error("llm upstream rejected", {
      upstreamStatus: response.status,
      geminiMs,
      keyFingerprint: apiKeyFingerprint(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
      body: errorText.slice(0, 400),
    })
    throw new LlmServiceError(
      `Gemini ${response.status} (model=${model} key=${apiKeyFingerprint()}): ${errorText.slice(0, 400)}`,
      classifyUpstream(response.status),
      response.status,
    )
  }

  const parseStarted = Date.now()
  const data = (await response.json()) as GeminiResponseBody
  const candidate = data.candidates?.[0]
  const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "{}"
  const finishReason = candidate?.finishReason
  const usage: GeminiUsage = {
    promptTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount,
    totalTokens: data.usageMetadata?.totalTokenCount,
  }
  const parseMs = Date.now() - parseStarted

  // A MAX_TOKENS finish truncates the JSON body, which then fails to parse and
  // silently yields zero words. Surfacing it turns a mystery into a budget dial.
  const truncated = finishReason === "MAX_TOKENS"
  if (truncated) {
    metrics.increment("llm_truncated_total", {op: opts.operation})
    call.warn("llm response truncated by token budget", {
      maxOutputTokens: opts.maxOutputTokens,
      outputTokens: usage.outputTokens,
    })
  }
  if (finishReason && finishReason !== "STOP" && !truncated) {
    metrics.increment("llm_finish_reason_total", {op: opts.operation, reason: finishReason})
    call.warn("llm unusual finish reason", {finishReason})
  }

  if (usage.totalTokens != null) {
    metrics.increment("llm_tokens_total", {op: opts.operation}, usage.totalTokens)
  }
  metrics.increment("llm_calls_total", {op: opts.operation, outcome: "ok"})
  call.info("llm ok", {
    geminiMs,
    parseMs,
    responseChars: text.length,
    finishReason,
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
  })

  return {text, geminiMs, parseMs, model, finishReason, usage, truncated}
}
