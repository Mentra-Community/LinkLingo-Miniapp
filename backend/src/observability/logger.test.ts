import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {createLogger} from "./logger"

const originalLevel = process.env.LOG_LEVEL
const originalFormat = process.env.LOG_FORMAT

function capture(fn: () => void): string[] {
  const lines: string[] = []
  const original = {log: console.log, warn: console.warn, error: console.error}
  const sink = (...args: unknown[]) => lines.push(args.map(String).join(" "))
  console.log = sink
  console.warn = sink
  console.error = sink
  try {
    fn()
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
  return lines
}

afterEach(() => {
  if (originalLevel == null) delete process.env.LOG_LEVEL
  else process.env.LOG_LEVEL = originalLevel
  if (originalFormat == null) delete process.env.LOG_FORMAT
  else process.env.LOG_FORMAT = originalFormat
})

describe("logger redaction", () => {
  // The suite runs with LOG_LEVEL=silent so service logs stay out of test
  // output; these cases opt back in.
  beforeEach(() => {
    process.env.LOG_LEVEL = "info"
  })

  test("masks fields whose names denote a secret", () => {
    const [line] = capture(() =>
      createLogger("t").info("check", {apiKey: "abc123", token: "xyz", authorization: "Bearer q"}),
    )
    expect(line).not.toContain("abc123")
    expect(line).not.toContain("xyz")
    expect(line).not.toContain("Bearer q")
    expect(line).toContain("apiKey=[redacted]")
  })

  test("keeps numeric token counts, which cannot be credentials", () => {
    const [line] = capture(() =>
      createLogger("t").info("usage", {promptTokens: 340, outputTokens: 12, maxOutputTokens: 128}),
    )
    expect(line).toContain("promptTokens=340")
    expect(line).toContain("outputTokens=12")
    expect(line).toContain("maxOutputTokens=128")
  })

  test("still masks a string token even though counts are allowed", () => {
    const [line] = capture(() => createLogger("t").info("auth", {token: "eyJhbGciOi"}))
    expect(line).toContain("token=[redacted]")
    expect(line).not.toContain("eyJhbGciOi")
  })

  test("keeps non-secret descriptors that merely mention a key", () => {
    const [line] = capture(() =>
      createLogger("t").info("check", {
        llmKeySource: "GEMINI_API_KEY",
        keyFingerprint: "b7b6fdb0",
        keyrings: "prod,dev",
      }),
    )
    expect(line).toContain("llmKeySource=GEMINI_API_KEY")
    expect(line).toContain("keyFingerprint=b7b6fdb0")
    expect(line).toContain("keyrings=prod,dev")
  })
})

describe("logger levels", () => {
  test("suppresses lines below the configured level", () => {
    process.env.LOG_LEVEL = "warn"
    const lines = capture(() => {
      const log = createLogger("t")
      log.debug("hidden")
      log.info("hidden")
      log.warn("shown")
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("shown")
  })

  test("emits parseable JSON when LOG_FORMAT=json", () => {
    process.env.LOG_FORMAT = "json"
    process.env.LOG_LEVEL = "info"
    const [line] = capture(() => createLogger("svc").info("hello", {count: 2}))
    const parsed = JSON.parse(line!) as Record<string, unknown>
    expect(parsed.scope).toBe("svc")
    expect(parsed.msg).toBe("hello")
    expect(parsed.count).toBe(2)
    expect(parsed.level).toBe("info")
  })
})

describe("logger context", () => {
  test("child loggers stamp bound fields onto every line", () => {
    process.env.LOG_LEVEL = "info"
    process.env.LOG_FORMAT = "logfmt"
    const [line] = capture(() => createLogger("t").child({op: "gloss"}).info("done", {ms: 5}))
    expect(line).toContain("op=gloss")
    expect(line).toContain("ms=5")
  })
})
