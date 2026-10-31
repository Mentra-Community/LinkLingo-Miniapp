import {describe, expect, test} from "bun:test"

import type {ViewBlock} from "../ui-blocks"
import {buildLearningView, learningState, type LearningViewInput} from "./learning-view"
import type {LearningStatus} from "./learning-outbox"

const NOW = Date.parse("2026-10-11T08:00:00.000Z")
const connected: LearningStatus = {
  enabled: true,
  problem: null,
  connected: true,
  label: "Mandarin",
  environment: "dev",
  lastAcceptedAt: "2026-10-11T07:58:00.000Z",
  pendingServerEvents: 0,
  lastError: null,
}
const phone = (state: string, pending = 0, extra: Partial<{gaps: number; lastError: string | null}> = {}) => ({
  state,
  pending,
  gaps: extra.gaps ?? 0,
  lastError: extra.lastError ?? null,
  at: "2026-10-11T07:59:00.000Z",
})

function flatten(blocks: ViewBlock[]): ViewBlock[] {
  return blocks.flatMap((block) => (block.type === "section" ? [block, ...flatten(block.blocks)] : [block]))
}
const texts = (input: LearningViewInput) =>
  flatten(buildLearningView({...input, now: NOW}).blocks)
    .filter((b): b is Extract<ViewBlock, {type: "text"}> => b.type === "text")
    .map((b) => b.text)

describe("learning state", () => {
  const cases: Array<[string, LearningViewInput, string]> = [
    [
      "unavailable server",
      {status: {...connected, enabled: false, connected: false, problem: "off"}, phone: null},
      "unavailable",
    ],
    ["not paired", {status: {...connected, connected: false, label: null}, phone: null}, "not_connected"],
    ["paired but the phone has not reported", {status: connected, phone: null}, "paused"],
    ["paused by the learner", {status: connected, phone: phone("paused")}, "paused"],
    ["capture on and nothing waiting", {status: connected, phone: phone("listening")}, "listening"],
    ["events waiting on the phone", {status: connected, phone: phone("listening", 3)}, "waiting"],
    [
      "events waiting on the server",
      {status: {...connected, pendingServerEvents: 2}, phone: phone("listening")},
      "waiting",
    ],
    [
      "server delivery failing",
      {status: {...connected, lastError: "Mandarin is unreachable"}, phone: phone("listening")},
      "attention",
    ],
    [
      "phone says it needs attention",
      {status: connected, phone: phone("needs_attention", 1, {lastError: "Sign-in expired"})},
      "attention",
    ],
  ]
  for (const [name, input, expected] of cases) {
    test(name, () => expect(learningState(input)).toBe(expected as ReturnType<typeof learningState>))
  }
})

describe("learning view", () => {
  test("Listening is described as capture being on, never as proof of delivery", () => {
    const all = texts({status: connected, phone: phone("listening")}).join(" ")
    expect(all).toContain("Listening")
    expect(all).toContain("not that anything has arrived")
  })

  test("the pairing field appears when not connected or needing attention, and never when healthy", () => {
    const has = (input: LearningViewInput) =>
      flatten(buildLearningView({...input, now: NOW}).blocks).some((b) => b.type === "input")
    expect(has({status: {...connected, connected: false}, phone: null})).toBe(true)
    expect(has({status: {...connected, lastError: "x"}, phone: null})).toBe(true)
    expect(has({status: connected, phone: phone("listening")})).toBe(false)
  })

  test("the capture toggle only shows once connected and is bound to the learning setting", () => {
    const toggle = (input: LearningViewInput) =>
      flatten(buildLearningView({...input, now: NOW}).blocks).find((b) => b.type === "toggle")
    expect(toggle({status: {...connected, connected: false}, phone: null})).toBeUndefined()
    expect(toggle({status: connected, phone: phone("paused")})).toMatchObject({key: "learningCapture"})
  })

  test("pending counts, last received time, and capture gaps are visible", () => {
    const view = buildLearningView({
      status: {...connected, pendingServerEvents: 4},
      phone: phone("listening", 2, {gaps: 1}),
      now: NOW,
    })
    const tiles = flatten(view.blocks).find((b) => b.type === "tiles") as Extract<ViewBlock, {type: "tiles"}>
    expect(tiles.items.map((i) => [i.label, i.value])).toEqual([
      ["Waiting on phone", 2],
      ["Waiting on server", 4],
      ["Last received", "2 min ago"],
    ])
    expect(texts({status: connected, phone: phone("listening", 0, {gaps: 1})}).join(" ")).toContain("could not be kept")
  })

  test("an actionable error is shown, and a missing connection never says Connected", () => {
    expect(texts({status: {...connected, lastError: "Pair again."}, phone: null}).join(" ")).toContain("Pair again.")
    const notConnected = texts({status: {...connected, connected: false, label: null}, phone: null}).join(" ")
    expect(notConnected).toContain("Not connected")
    expect(notConnected).not.toContain("Connected to")
  })
})
