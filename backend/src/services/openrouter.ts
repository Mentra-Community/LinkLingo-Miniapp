import {createHash} from "node:crypto"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"

const log = createLogger("openrouter")

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
  /** Overrides the live-path model; the analyst uses a slower, smarter one. */
  model?: string
  /** Reasoning budget. The live path stays "minimal"; the analyst gets to think. */
  thinkingLevel?: "minimal" | "low" | "medium" | "high"
  /**
   * Upstream to pin. Callers pass this explicitly because the live path and the
   * analyst run on different silicon: pinning the live path's provider onto a
   * Google model would make every analyst call fail.
   */
  provider?: string
}

/** User-triggered analyst calls retain a stronger model than the live path. */
export function resolveAnalystModel(): string {
  return process.env.OPENROUTER_ANALYST_MODEL || "google/gemini-3.1-pro-preview"
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
  return process.env.OPENROUTER_MODEL || "google/gemini-3.5-flash-lite"
}

/**
 * Upstream for the live path. Unset means "let OpenRouter choose", which picks
 * the cheapest reseller and measured a p95 of 1206ms against 430ms pinned — the
 * pin is what buys the latency, not the model slug alone.
 */
export function resolveProvider(): string | undefined {
  return process.env.OPENROUTER_PROVIDER || undefined
}

/** The analyst runs on a different model, so it pins separately or not at all. */
export function resolveAnalystProvider(): string | undefined {
  return process.env.OPENROUTER_ANALYST_PROVIDER || undefined
}

export function resolveApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY
}

export function resolveApiKeySource(): string | undefined {
  return process.env.OPENROUTER_API_KEY ? "OPENROUTER_API_KEY" : undefined
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
 * Upstream provider failures are not all the same class of problem, and calling
 * every one of them a 500 hides quota exhaustion and bad keys behind a generic
 * server error.
 */
function classifyUpstream(status: number): LlmErrorStatus {
  if (status === 429) return 429
  if (status === 401 || status === 403) return 503
  if (status >= 500) return 503
  return 400
}

interface OpenRouterResponseBody {
  error?: unknown
  choices?: Array<{message?: {content?: string | null}; finish_reason?: string}>
  usage?: {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number}
}

/**
 * Convert Gemini schema type names while retaining the caller's output schema.
 *
 * Every object node also gets `additionalProperties: false`. Cerebras rejects a
 * strict schema without it (HTTP 400, "'additionalProperties' is required to be
 * supplied and set to false"); Google and Groq accept it either way.
 */
function jsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonSchema)
  if (value && typeof value === "object") {
    const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, key === "type" && typeof item === "string" ? item.toLowerCase() : jsonSchema(item),
    ]))
    if (typeof mapped.type === "string" && mapped.type === "object") mapped.additionalProperties = false
    return mapped
  }
  return value
}

export async function generateJson(opts: GeminiCallOptions): Promise<GeminiCallResult> {
  const apiKey = resolveApiKey()
  const model = opts.model ?? resolveModel()
  const call = log.child({op: opts.operation, model, provider: opts.provider})

  if (!apiKey) {
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "no_key"})
    call.error("no API key configured", {checked: "OPENROUTER_API_KEY"})
    throw new LlmServiceError("OPENROUTER_API_KEY is required", 503)
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
      `${(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Mentra LinkLingo"},
        body: JSON.stringify({
          model,
          messages: [{role: "system", content: opts.system}, {role: "user", content: opts.user}],
          max_tokens: opts.maxOutputTokens,
          response_format: {type: "json_schema", json_schema: {name: "linklingo_response", schema: jsonSchema(opts.responseSchema)}},
          reasoning: {effort: !opts.thinkingLevel || opts.thinkingLevel === "minimal" ? "minimal" : opts.thinkingLevel},
          // Absent `only`, OpenRouter routes by price, not speed.
          ...(opts.provider ? {provider: {only: [opts.provider], allow_fallbacks: false}} : {}),
        }),
        signal: AbortSignal.timeout(60_000),
      },
    )
  } catch (error) {
    const geminiMs = Date.now() - started
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "transport_error"})
    metrics.observe("llm_call_duration", geminiMs, {op: opts.operation})
    call.error("llm transport failure", {geminiMs, error})
    throw new LlmServiceError("OpenRouter unreachable", 503)
  }

  const geminiMs = Date.now() - started
  metrics.observe("llm_call_duration", geminiMs, {op: opts.operation})

  if (!response.ok) {
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "upstream_error"})
    metrics.increment("llm_upstream_status_total", {op: opts.operation, status: response.status})
    call.error("llm upstream rejected", {
      upstreamStatus: response.status,
      geminiMs,
      keyFingerprint: apiKeyFingerprint(),
      retryAfter: response.headers.get("retry-after") ?? undefined,
    })
    throw new LlmServiceError(
      `OpenRouter ${response.status} (model=${model}${opts.provider ? `, provider=${opts.provider}` : ""})`,
      classifyUpstream(response.status),
      response.status,
    )
  }

  const parseStarted = Date.now()
  const data = (await response.json()) as OpenRouterResponseBody
  const candidate = data.choices?.[0]
  if (data.error || typeof candidate?.message?.content !== "string") {
    metrics.increment("llm_calls_total", {op: opts.operation, outcome: "upstream_error"})
    throw new LlmServiceError("OpenRouter returned no usable content", 503)
  }
  const text = candidate.message.content
  // Keep legacy response fields for installed miniapp clients.
  const finishReason = candidate.finish_reason === "length" ? "MAX_TOKENS"
    : candidate.finish_reason === "stop" ? "STOP" : candidate.finish_reason
  const usage: GeminiUsage = {
    promptTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    totalTokens: data.usage?.total_tokens,
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
