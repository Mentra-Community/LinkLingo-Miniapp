import {afterEach, beforeEach, describe, expect, test} from "bun:test"

import {reportTranscript, requestConfig, requestView, setPrefs} from "./backend"

/**
 * The phone runs the background bundle in JavaScriptCore / QuickJS, whose
 * polyfill has fetch but neither `Headers` nor `URLSearchParams`. Bun has both,
 * so a request that needs one only fails on the phone. These tests take them
 * away, the way the phone does.
 */

const realHeaders = globalThis.Headers
const realSearchParams = globalThis.URLSearchParams

beforeEach(() => {
  globalThis.Headers = undefined as never
  globalThis.URLSearchParams = undefined as never
})

afterEach(() => {
  globalThis.Headers = realHeaders
  globalThis.URLSearchParams = realSearchParams
  setPrefs({})
})

function fakeSession() {
  const calls: Array<{url: string; headers: unknown}> = []
  const session = {
    auth: {
      fetch: async (url: string, init: {headers?: unknown}) => {
        calls.push({url, headers: init.headers})
        return new Response("{}", {status: 200})
      },
    },
  }
  return {session: session as never, calls}
}

describe("backend requests without Headers or URLSearchParams", () => {
  test("the settings request leaves the phone", async () => {
    const {session, calls} = fakeSession()
    const result = await requestConfig(session)
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.endsWith("/api/config")).toBe(true)
  })

  test("a transcript report leaves the phone and keeps its headers", async () => {
    const {session, calls} = fakeSession()
    setPrefs({alpha: true})
    reportTranscript(session, {
      text: "I have a bad connection",
      inputLanguage: "zh",
      outputLanguage: "en",
      fluencyLevel: 50,
      mode: "gloss-captions",
      disposition: "reverse_gloss",
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.endsWith("/api/transcript")).toBe(true)
    expect(calls[0]!.headers).toEqual({
      "Content-Type": "application/json",
      "X-LinkLingo-Prefs": encodeURIComponent(JSON.stringify({alpha: true})),
    })
  })

  test("a report never throws into the transcription handler", () => {
    const {session} = fakeSession()
    expect(() =>
      reportTranscript(session, {
        text: "hello",
        inputLanguage: "zh",
        outputLanguage: "en",
        fluencyLevel: 50,
        mode: "gloss-captions",
        disposition: "skipped_language",
      }),
    ).not.toThrow()
  })

  test("a server-driven tab builds its query by hand", async () => {
    const {session, calls} = fakeSession()
    await requestView(session, "reports", {period: "day", tz: "480", note: "a b&c"})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.endsWith("/api/views/reports?period=day&tz=480&note=a%20b%26c")).toBe(true)
  })
})
