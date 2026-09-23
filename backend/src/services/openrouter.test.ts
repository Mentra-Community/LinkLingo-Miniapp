import {afterEach, expect, test} from 'bun:test'
import {DEFAULT_ANALYST_MODEL, generateJson, resolveAnalystModel, resolveModel} from './openrouter'
const originalFetch = globalThis.fetch
const originalKey = process.env.OPENROUTER_API_KEY
const opts = {system: 'Translate', user: '你好', maxOutputTokens: 100, operation: 'test', responseSchema: {type: 'OBJECT', properties: {text: {type: 'STRING'}}}}
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = originalKey
})
test('the analyst has its own default and does not inherit the live gloss model', () => {
  const previous = process.env.OPENROUTER_ANALYST_MODEL
  delete process.env.OPENROUTER_ANALYST_MODEL
  try {
    expect(resolveAnalystModel()).toBe(DEFAULT_ANALYST_MODEL)
    expect(resolveAnalystModel()).not.toBe(resolveModel())
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_ANALYST_MODEL
    else process.env.OPENROUTER_ANALYST_MODEL = previous
  }
})
test('routes structured output through OpenRouter and preserves legacy response fields', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-key')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(resolveModel())
    // additionalProperties is injected: Cerebras 400s on a strict schema without it.
    expect(body.response_format.json_schema.schema).toEqual({type: 'object', properties: {text: {type: 'string'}}, additionalProperties: false})
    expect(body.reasoning.effort).toBe('minimal')
    expect(body.tools).toBeUndefined()
    expect(body.provider).toBeUndefined()
    return Response.json({choices: [{message: {content: '{"text":"hello"}'}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}})
  }) as unknown as typeof fetch
  const result = await generateJson(opts)
  expect(result.text).toBe('{"text":"hello"}')
  expect(result.finishReason).toBe('STOP')
  expect(result.truncated).toBe(false)
  expect(result.llmMs).toBeGreaterThanOrEqual(0)
  expect(result.usage.totalTokens).toBe(15)
})
test('analyst model and reasoning remain separately configurable; length maps to truncation', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe(resolveAnalystModel())
    expect(body.reasoning.effort).toBe('high')
    return Response.json({choices: [{message: {content: '{'}, finish_reason: 'length'}]})
  }) as unknown as typeof fetch
  expect((await generateJson({...opts, model: resolveAnalystModel(), thinkingLevel: 'high'})).truncated).toBe(true)
})
test('an explicit provider is pinned with fallbacks off, so routing cannot pick a slower reseller', async () => {
  process.env.OPENROUTER_API_KEY = 'test-key'
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    expect(JSON.parse(init.body as string).provider).toEqual({only: ['cerebras'], allow_fallbacks: false})
    return Response.json({choices: [{message: {content: '{"text":"hi"}'}, finish_reason: 'stop'}]})
  }) as unknown as typeof fetch
  expect((await generateJson({...opts, provider: 'cerebras'})).text).toBe('{"text":"hi"}')
})
test('missing credentials, provider errors, and empty responses fail explicitly', async () => {
  delete process.env.OPENROUTER_API_KEY
  await expect(generateJson(opts)).rejects.toThrow('OPENROUTER_API_KEY')
  process.env.OPENROUTER_API_KEY = 'test-key'
  for (const [status, expected] of [[429, 429], [401, 503], [503, 503]]) {
    globalThis.fetch = (async () => new Response('private upstream detail', {status})) as unknown as typeof fetch
    try {await generateJson(opts); throw new Error('expected rejection')} catch (error: any) {
      expect(error.status).toBe(expected)
      expect(error.message).not.toContain('private upstream detail')
    }
  }
  globalThis.fetch = (async () => Response.json({choices: []})) as unknown as typeof fetch
  await expect(generateJson(opts)).rejects.toThrow('no usable content')
})
