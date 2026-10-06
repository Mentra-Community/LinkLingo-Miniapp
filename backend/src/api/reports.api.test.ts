import {beforeEach, describe, expect, mock, test} from "bun:test"
import {Hono} from "hono"

import type {Report} from "../shared-types"
import {noteAuthenticatedUser, requestObservability} from "./observability"

// Stands in for token verification: the test names the caller in a header.
mock.module("./auth", () => ({
  mentraAuthMiddleware: () => async (c: {req: {header(name: string): string | undefined}}, next: () => Promise<void>) => {
    noteAuthenticatedUser(c.req.header("x-test-user"))
    await next()
  },
}))

const {reportsApi} = await import("./reports.api")
const {historyStore} = await import("../services/history-store")
const {digest} = await import("../services/review-log")

const app = new Hono()
app.use("*", requestObservability)
app.route("/api/reports", reportsApi)

const get = (path: string, user?: string) =>
  app.request(path, {headers: user ? {"x-test-user": user} : {}})
const report = async (path: string, user: string) => (await (await get(path, user)).json()) as Report

beforeEach(() => {
  historyStore.attach(null)
  historyStore.clear()
})

describe("reports api", () => {
  test("a caller only sees their own ledger, whatever the query says", async () => {
    const now = Date.now()
    historyStore.record(digest("alice"), {kind: "gloss", at: now, word: "博物馆", translation: "museum", in: "zh", out: "en"})
    historyStore.record(digest("bob"), {kind: "gloss", at: now, word: "参观", translation: "to visit", in: "zh", out: "en"})

    const alice = await report(`/api/reports?range=day&tzOffsetMin=0&user=${digest("bob")}`, "alice")
    expect(alice.topWords.map((w) => w.word)).toEqual(["博物馆"])
    const bob = await report("/api/reports?range=day&tzOffsetMin=0", "bob")
    expect(bob.topWords.map((w) => w.word)).toEqual(["参观"])
  })

  test("rejects anonymous callers and bad parameters", async () => {
    expect((await get("/api/reports?range=day")).status).toBe(401)
    expect((await get("/api/reports?range=month", "alice")).status).toBe(400)
    expect((await get("/api/reports?range=day&tzOffsetMin=9999", "alice")).status).toBe(400)
    expect((await get("/api/reports?range=week&date=yesterday", "alice")).status).toBe(400)
  })

  test("a week report has seven days", async () => {
    const week = await report("/api/reports?range=week&tzOffsetMin=-480&date=2026-10-06", "alice")
    expect(week.days).toHaveLength(7)
    expect(week.date).toBe("2026-10-06")
  })
})
