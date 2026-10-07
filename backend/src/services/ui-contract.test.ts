import {describe, expect, test} from "bun:test"
import {readFileSync} from "node:fs"
import {join} from "node:path"

import {buildAppConfig} from "./app-config"
import {buildReportView} from "./report-view"
import {buildReport, reportPeriod} from "./history-report"
import {VIEWS} from "./views"
import type {ViewBlock} from "../ui-blocks"

const root = join(import.meta.dir, "..", "..", "..")
// Loaded by path, not imported, so the backend's typecheck never pulls in phone code.
const phone = (await import(join(root, "miniapp/src/shared/serverContract.ts"))) as {
  SETTABLE_KEYS: readonly string[]
  TUNABLE_LIMITS: Record<string, readonly [number, number]>
}

const SETTING_TYPES = new Set(["toggle", "select", "slider"])
const VIEW_TYPES = new Set(["section", "tiles", "bars", "words", "list", "text", ...SETTING_TYPES])

function walk(blocks: ViewBlock[], visit: (block: ViewBlock) => void): void {
  for (const block of blocks) {
    visit(block)
    if (block.type === "section") walk(block.blocks, visit)
  }
}

describe("server-driven UI contract", () => {
  test("the block kit is the same file on both sides", () => {
    const server = readFileSync(join(root, "backend/src/ui-blocks.ts"), "utf8")
    const client = readFileSync(join(root, "miniapp/src/shared/blocks.ts"), "utf8")
    expect(client).toBe(server)
  })

  test("every settings row binds to something an installed phone can change", () => {
    const allowed = new Set(phone.SETTABLE_KEYS)
    walk(buildAppConfig().settings, (block) => {
      expect(VIEW_TYPES.has(block.type)).toBe(true)
      if (!SETTING_TYPES.has(block.type)) return
      const key = (block as {key: string}).key
      expect(allowed.has(key) || /^prefs\.[A-Za-z][A-Za-z0-9_]*$/.test(key)).toBe(true)
    })
  })

  test("tunables are names the phone reads, inside the ranges it accepts", () => {
    for (const [name, value] of Object.entries(buildAppConfig().tunables)) {
      const limits = phone.TUNABLE_LIMITS[name]
      expect(limits).toBeDefined()
      expect(value).toBeGreaterThanOrEqual(limits![0])
      expect(value).toBeLessThanOrEqual(limits![1])
    }
  })

  test("every advertised screen has a view builder", () => {
    for (const screen of buildAppConfig().screens) expect(Object.keys(VIEWS)).toContain(screen.id)
  })

  test("the revision changes when the content does", () => {
    const a = buildAppConfig()
    expect(a.revision).toBe(buildAppConfig().revision)
    expect(a.revision).toMatch(/^[0-9a-f]{8}$/)
  })

  test("the report view only uses known blocks and carries the mistakes sections", () => {
    const period = reportPeriod("week", "2026-10-06", -480)
    const view = buildReportView(
      buildReport(period, [{kind: "reverse", at: period.from + 1000, word: "museum", translation: "博物馆", in: "en", out: "zh"}]),
    )
    const titles: string[] = []
    walk(view.blocks, (block) => {
      expect(VIEW_TYPES.has(block.type)).toBe(true)
      if ("title" in block && block.title) titles.push(block.title)
    })
    expect(titles).toEqual(expect.arrayContaining(["Mistakes", "Words you couldn't say", "Not sticking yet", "Possible errors"]))
    expect(view.blocks.some((b) => b.type === "section" && b.blocks.some((x) => x.type === "bars"))).toBe(true)
  })
})
