/**
 * Which build of the backend this pod is running.
 *
 * Phase 2 of the latency program changes only the server, so "before" and
 * "after" are the same miniapp version and would otherwise be
 * indistinguishable in the review tape. The deploy workflow stamps the commit
 * into `build-id.txt` at the image root before `porter apply`; the committed
 * copy says `dev`, which is the signal to fall back to the working tree's git
 * SHA (present locally, absent inside the image).
 */

import {existsSync, readFileSync} from "node:fs"
import {resolve} from "node:path"

const UNSTAMPED = "dev"

let cached: string | null = null

export function serverBuildId(): string {
  if (cached == null) cached = resolve_()
  return cached
}

function resolve_(): string {
  const explicit = process.env.LINKLINGO_BUILD_ID?.trim()
  if (explicit) return explicit

  const stamped = readStamp()
  if (stamped && stamped !== UNSTAMPED) return stamped

  return gitSha() ?? UNSTAMPED
}

function readStamp(): string | null {
  try {
    const path = resolve(process.cwd(), "build-id.txt")
    if (!existsSync(path)) return null
    return readFileSync(path, "utf8").trim() || null
  } catch {
    // An unreadable build stamp must never stop the pod booting.
    return null
  }
}

function gitSha(): string | null {
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {stderr: "ignore"})
    if (git.exitCode !== 0) return null
    return new TextDecoder().decode(git.stdout).trim() || null
  } catch {
    return null
  }
}
