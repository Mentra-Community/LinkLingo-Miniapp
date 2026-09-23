/**
 * Turns a change request from the ask box into a Cursor cloud agent that
 * edits the repository and pushes to `main`. The dev deploy workflow picks
 * up the push, so backend changes go live without anyone approving them.
 * Only allowlisted Mentra accounts can trigger it; the repo is public and a
 * push is a deploy.
 */

import {Agent, CursorAgentError} from "@cursor/sdk"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import type {CodeChange} from "../shared-types"

const log = createLogger("code-agent")

const DEFAULT_MODEL = "composer-2.5"

export interface CodeAgentConfig {
  apiKey?: string
  repo?: string
  users: Set<string>
  model: string
}

export function codeAgentConfig(env: NodeJS.ProcessEnv = process.env): CodeAgentConfig {
  return {
    apiKey: env.CURSOR_API_KEY?.trim() || undefined,
    repo: env.LINKLINGO_CODE_AGENT_REPO?.trim() || undefined,
    users: new Set(
      (env.LINKLINGO_CODE_AGENT_USERS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
    model: env.LINKLINGO_CODE_AGENT_MODEL?.trim() || DEFAULT_MODEL,
  }
}

export type CodeAgentGate = "ok" | "disabled" | "not_allowed" | "busy"

let inFlight = 0

/** One build at a time: two agents pushing to `main` at once would race each other's deploys. */
export function codeAgentGate(userId: string | undefined, config = codeAgentConfig()): CodeAgentGate {
  if (!config.apiKey || !config.repo) return "disabled"
  if (!userId || !config.users.has(userId)) return "not_allowed"
  if (inFlight > 0) return "busy"
  return "ok"
}

export function buildAgentPrompt(input: {note: string; instruction: string; feedbackId: string}): string {
  return [
    "A LinkLingo user asked for a change from the comment box on their smart glasses.",
    "",
    `What they said:\n"""\n${input.note}\n"""`,
    "",
    `Instruction from the analyst, who saw their recent speech and gloss tape:\n"""\n${input.instruction}\n"""`,
    "",
    "Make the smallest change that does what they asked. Rules:",
    "- You are on `main`. Commit there and push to `origin main`; do not open a pull request. The push deploys to the dev server.",
    "- Run `bun install`, then `bun run typecheck` and `bun run test`. Push only if both pass. If you cannot make them pass, push nothing and explain why.",
    "- Add or update a test that shows the new behaviour.",
    "- If you change anything under `miniapp/`, bump the patch version in `miniapp/miniapp.json`.",
    "- Do not edit `porter.*.yaml`, `.github/`, `docker/`, secrets, or anything that changes who can install or publish the app.",
    `- Use a conventional commit message and end the body with \`Requested-from: ask-box ${input.feedbackId}\`.`,
    "",
    "When you finish, reply with one short paragraph: what changed, whether it was pushed, and whether it needs a new glasses install (anything under `miniapp/`) or only the backend deploy.",
  ].join("\n")
}

/**
 * Starts the agent and returns as soon as it is running. The run itself
 * takes minutes, so `onDone` fires later with the outcome; a pod evicted in
 * the meantime loses the callback, not the agent, which keeps running on
 * Cursor's side and still pushes.
 */
export async function startCodeChange(
  input: {note: string; instruction: string; feedbackId: string},
  onDone: (change: CodeChange) => void,
  config = codeAgentConfig(),
): Promise<CodeChange> {
  const startedAt = Date.now()
  inFlight++
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined
  try {
    agent = await Agent.create({
      apiKey: config.apiKey,
      model: {id: config.model},
      name: `LinkLingo ask box ${input.feedbackId}`,
      cloud: {
        repos: [{url: config.repo!, startingRef: "main"}],
        workOnCurrentBranch: true,
        autoCreatePR: false,
        skipReviewerRequest: true,
        metadata: {source: "linklingo-ask-box", feedbackId: input.feedbackId},
      },
    })
    const run = await agent.send(buildAgentPrompt(input))
    const started: CodeChange = {status: "started", agentId: agent.agentId, runId: run.id, at: startedAt}
    log.info("code change started", {feedbackId: input.feedbackId, agentId: agent.agentId, runId: run.id})
    metrics.increment("code_agent_runs_total", {outcome: "started"})

    const owned = agent
    void run
      .wait()
      .then(
        (result) => {
          const ok = result.status === "finished"
          metrics.increment("code_agent_runs_total", {outcome: result.status})
          log.info("code change finished", {feedbackId: input.feedbackId, agentId: owned.agentId, status: result.status})
          onDone({
            ...started,
            status: ok ? "finished" : "failed",
            detail: (ok ? result.result : result.error?.message ?? result.result)?.slice(0, 1200),
            finishedAt: Date.now(),
          })
        },
        (error) => {
          metrics.increment("code_agent_runs_total", {outcome: "wait_error"})
          log.warn("code change wait failed", {feedbackId: input.feedbackId, agentId: owned.agentId, error})
          onDone({...started, status: "failed", detail: String((error as Error)?.message ?? error), finishedAt: Date.now()})
        },
      )
      .finally(async () => {
        inFlight--
        await owned[Symbol.asyncDispose]?.().catch(() => undefined)
      })
    return started
  } catch (error) {
    inFlight--
    await agent?.[Symbol.asyncDispose]?.().catch(() => undefined)
    const message = error instanceof CursorAgentError ? error.message : String((error as Error)?.message ?? error)
    metrics.increment("code_agent_runs_total", {outcome: "start_error"})
    log.error("code change failed to start", {feedbackId: input.feedbackId, error})
    return {status: "failed", detail: message.slice(0, 400), at: startedAt, finishedAt: Date.now()}
  }
}

/** What the glasses user reads under the analyst's answer. */
export function describeChange(gate: CodeAgentGate, change?: CodeChange): string {
  if (gate === "disabled") return "Change requests are not connected to a coding agent yet, so nothing was built."
  if (gate === "not_allowed") return "This account cannot send changes to be built."
  if (gate === "busy") return "Another change is still being built. Send this one again when it finishes."
  if (!change || change.status === "failed") return `The coding agent could not start: ${change?.detail ?? "unknown error"}.`
  return "Sent to a coding agent. Backend changes reach the dev server about 10 minutes after it pushes; glasses-side changes also need the new install QR."
}
