import {describe, expect, test} from "bun:test"

import {buildAgentPrompt, codeAgentConfig, codeAgentGate, describeChange} from "./code-agent"
import {FeedbackLog} from "./feedback-log"

const HOUR = 3_600_000

describe("code agent gate", () => {
  const env = {
    CURSOR_API_KEY: "key",
    LINKLINGO_CODE_AGENT_REPO: "https://github.com/Mentra-Community/LinkLingo-Miniapp",
    LINKLINGO_CODE_AGENT_USERS: " mu_owner , mu_other ",
  }

  test("stays off until both the key and the repo are configured", () => {
    expect(codeAgentGate("mu_owner", codeAgentConfig({}))).toBe("disabled")
    expect(codeAgentGate("mu_owner", codeAgentConfig({CURSOR_API_KEY: "key"}))).toBe("disabled")
  })

  test("only allowlisted accounts can push, because a push is a deploy", () => {
    const config = codeAgentConfig(env)
    expect(codeAgentGate("mu_owner", config)).toBe("ok")
    expect(codeAgentGate("mu_other", config)).toBe("ok")
    expect(codeAgentGate("mu_stranger", config)).toBe("not_allowed")
    expect(codeAgentGate(undefined, config)).toBe("not_allowed")
    expect(codeAgentGate("mu_owner", codeAgentConfig({...env, LINKLINGO_CODE_AGENT_USERS: ""}))).toBe("not_allowed")
  })

  test("defaults the agent model and trims the allowlist", () => {
    const config = codeAgentConfig(env)
    expect(config.model).toBe("composer-2.5")
    expect([...config.users]).toEqual(["mu_owner", "mu_other"])
  })
})

describe("agent prompt", () => {
  test("carries the request and the guardrails the push depends on", () => {
    const prompt = buildAgentPrompt({note: "gloss my English into Chinese too", instruction: "Route en utterances as en→zh", feedbackId: "abc-1"})
    expect(prompt).toContain("gloss my English into Chinese too")
    expect(prompt).toContain("Route en utterances as en→zh")
    expect(prompt).toContain("bun run typecheck")
    expect(prompt).toContain("bun run test")
    expect(prompt).toContain("do not open a pull request")
    expect(prompt).toContain("miniapp/miniapp.json")
    expect(prompt).toContain("porter.*.yaml")
    expect(prompt).toContain("Requested-from: ask-box abc-1")
  })
})

describe("what the glasses user is told", () => {
  test("never claims a change was built when it was not", () => {
    expect(describeChange("disabled")).toContain("nothing was built")
    expect(describeChange("not_allowed")).toContain("cannot send changes")
    expect(describeChange("busy")).toContain("still being built")
    expect(describeChange("ok", {status: "failed", detail: "401", at: 1})).toContain("could not start: 401")
    expect(describeChange("ok", {status: "started", agentId: "bc-1", at: 1})).toContain("Sent to a coding agent")
  })
})

describe("feedback log change tracking", () => {
  test("the agent's outcome lands on the comment that asked for it", () => {
    const log = new FeedbackLog(24 * HOUR, 100, null)
    const entry = log.record(
      {
        note: "change it",
        snapshot: {
          settings: {inputLanguage: "zh", outputLanguage: "en", proficiency: 33, mode: "gloss"},
          recentUtterances: [],
          shownWords: [],
          recentWords: [],
          caption: "",
          translation: "",
          original: "",
        },
        tape: {transcripts: 0, glossCalls: 0, windowMs: 600_000},
        analysis: {id: "", model: "m", answer: "ok", totalMs: 1},
      },
      Date.now(),
    )
    expect(log.setChange(entry.id, {status: "finished", agentId: "bc-9", detail: "pushed", at: 1, finishedAt: 2})).toBe(true)
    expect(log.list({})[0].analysis.change?.status).toBe("finished")
    expect(log.setChange("missing", {status: "failed", at: 1})).toBe(false)
  })
})
