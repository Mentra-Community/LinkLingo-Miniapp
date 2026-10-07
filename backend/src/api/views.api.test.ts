import {beforeEach, describe, expect, mock, test} from "bun:test"
import {Hono} from "hono"

import type {View} from "../ui-blocks"
import {noteAuthenticatedUser, parsePrefs, PREFS_HEADER, requestObservability} from "./observability"

mock.module("./auth", () => ({
  mentraAuthMiddleware: () => async (c: {req: {header(name: string): string | undefined}}, next: () => Promise<void>) => {
    noteAuthenticatedUser(c.req.header("x-test-user"))
    await next()
  },
}))

const {viewsApi} = await import("./views.api")
const {configApi} = await import("./config.api")
const {historyStore} = await import("../services/history-store")
const {digest} = await import("../services/review-log")

const app = new Hono()
app.use("*", requestObservability)
app.route("/api/views", viewsApi)
app.route("/api/config", configApi)

const get = (path: string, user?: string, prefs?: Record<string, unknown>) =>
  app.request(path, {
    headers: {
      ...(user ? {"x-test-user": user} : {}),
      ...(prefs ? {[PREFS_HEADER]: encodeURIComponent(JSON.stringify(prefs))} : {}),
    },
  })

function findSection(view: View, title: string) {
  for (const section of view.blocks) {
    if (section.type !== "section") continue
    for (const block of section.blocks) {
      if ("title" in block && block.title === title) return block
    }
  }
  return undefined
}

beforeEach(() => {
  historyStore.attach(null)
  historyStore.clear()
})

describe("views api", () => {
  test("the reports tab comes back as blocks for the caller only", async () => {
    const now = Date.now()
    historyStore.record(digest("alice"), {kind: "reverse", at: now, word: "museum", translation: "博物馆", in: "en", out: "zh"})
    historyStore.record(digest("bob"), {kind: "reverse", at: now, word: "embassy", translation: "大使馆", in: "en", out: "zh"})
    const view = (await (await get("/api/views/reports?range=day&tzOffsetMin=0", "alice")).json()) as View
    const fallbacks = findSection(view, "Words you couldn't say") as {items: Array<{word: string}>}
    expect(fallbacks.items.map((i) => i.word)).toEqual(["museum"])
  })

  test("a backend-only pref the phone has never heard of changes the screen", async () => {
    const now = Date.now()
    for (let i = 0; i < 2; i++) {
      historyStore.record(digest("alice"), {kind: "gloss", at: now + i, word: "参观", translation: "to visit", in: "zh", out: "en"})
    }
    const strict = (await (await get("/api/views/reports?range=day&tzOffsetMin=0", "alice")).json()) as View
    expect((findSection(strict, "Not sticking yet") as {items: unknown[]}).items).toHaveLength(0)
    const loose = (await (await get("/api/views/reports?range=day&tzOffsetMin=0", "alice", {repeatThreshold: 2})).json()) as View
    const repeats = findSection(loose, "Not sticking yet") as {hint: string; items: unknown[]}
    expect(repeats.items).toHaveLength(1)
    expect(repeats.hint).toContain("2 or more")
  })

  test("unknown screens 404 and anonymous callers are refused", async () => {
    expect((await get("/api/views/nope", "alice")).status).toBe(404)
    expect((await get("/api/views/reports?range=day")).status).toBe(401)
  })

  test("config is served to a signed-in phone", async () => {
    const config = (await (await get("/api/config", "alice")).json()) as {screens: Array<{id: string}>; tunables: object}
    expect(config.screens.map((s) => s.id)).toContain("reports")
    expect(Object.keys(config.tunables).length).toBeGreaterThan(0)
  })
})

describe("prefs header", () => {
  test("keeps flat primitives and drops everything else", () => {
    expect(parsePrefs(encodeURIComponent(JSON.stringify({a: 1, b: true, c: "x", d: {nested: 1}, "bad key": 2})))).toEqual({
      a: 1,
      b: true,
      c: "x",
    })
    expect(parsePrefs("not json")).toBeUndefined()
    expect(parsePrefs(encodeURIComponent("[1,2]"))).toBeUndefined()
    expect(parsePrefs("x".repeat(5000))).toBeUndefined()
  })
})
