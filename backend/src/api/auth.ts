import {MentraAuthError, createMentraAuth, type HonoLikeContext} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {noteAuthenticatedUser} from "./observability"

const log = createLogger("auth")

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.mentra.link"
const PROD_JWKS = "https://core.mentraglass.com/.well-known/jwks.json"
const DEV_JWKS = "https://core.dev.us-west-2.mentraglass.com/.well-known/jwks.json"

export function allowUnauth(): boolean {
  return process.env.LINKLINGO_ALLOW_UNAUTH === "true"
}

/** Human-readable name for a JWKS URL so logs say "prod" instead of a long host. */
function jwksLabel(url: string): string {
  if (url === PROD_JWKS) return "prod"
  if (url === DEV_JWKS) return "dev"
  return new URL(url).host
}

function jwksCandidates(): string[] {
  const configured = (process.env.MENTRA_AUTH_JWKS_URL ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...configured, PROD_JWKS, DEV_JWKS])]
}

const candidateUrls = jwksCandidates()
const verifiers = candidateUrls.map((jwksUrl) => ({
  label: jwksLabel(jwksUrl),
  auth: createMentraAuth({packageName: PACKAGE_NAME, jwksUrl}),
}))

log.info("auth configured", {
  package: PACKAGE_NAME,
  keyrings: verifiers.map((v) => v.label).join(","),
  configured: process.env.MENTRA_AUTH_JWKS_URL ? jwksLabel(candidateUrls[0]!) : "(none)",
  allowUnauth: allowUnauth(),
})

export function mentraAuthMiddleware() {
  if (allowUnauth()) {
    log.warn("authentication disabled by LINKLINGO_ALLOW_UNAUTH")
    return async (c: HonoLikeContext, next: () => Promise<void>) => {
      c.set("mentraAuth", {
        mentraUserId: "local-dev",
        packageName: PACKAGE_NAME,
        claims: {},
      })
      metrics.increment("auth_results_total", {outcome: "bypassed"})
      await next()
    }
  }

  return async (c: HonoLikeContext, next: () => Promise<void>) => {
    const header = c.req.header("Authorization")
    if (!header) {
      metrics.increment("auth_results_total", {outcome: "missing_header"})
      log.warn("request has no Authorization header", {expectedAud: PACKAGE_NAME})
      return c.json({error: "missing bearer token"}, 401)
    }

    const started = Date.now()
    let lastError: MentraAuthError | undefined
    const attempts: string[] = []

    for (const {label, auth} of verifiers) {
      try {
        const verified = await auth.verifyAuthHeader(header)
        // Which keyring accepted the token is the single most useful auth fact:
        // a prod token arriving at a dev-configured backend looks identical to
        // a forged one until you know this.
        metrics.increment("auth_results_total", {outcome: "ok"})
        metrics.increment("auth_keyring_hits_total", {keyring: label})
        metrics.observe("auth_verify_duration", Date.now() - started)
        noteAuthenticatedUser(verified.mentraUserId)
        log.debug("token verified", {
          keyring: label,
          attempts: attempts.length + 1,
          verifyMs: Date.now() - started,
        })
        if (attempts.length > 0) {
          log.info("token verified by fallback keyring", {
            keyring: label,
            rejectedBy: attempts.join(","),
          })
        }
        c.set("mentraAuth", verified)
        await next()
        return
      } catch (error) {
        if (error instanceof MentraAuthError) {
          lastError = error
          attempts.push(label)
          continue
        }
        metrics.increment("auth_results_total", {outcome: "error"})
        log.error("keyring threw a non-auth error", {keyring: label, error})
        throw error
      }
    }

    const message = lastError?.message ?? "miniapp token rejected"
    metrics.increment("auth_results_total", {outcome: "rejected"})
    log.warn("token rejected by every keyring", {
      expectedAud: PACKAGE_NAME,
      tried: attempts.join(","),
      verifyMs: Date.now() - started,
      reason: message,
    })
    return c.json({error: message}, 401)
  }
}
