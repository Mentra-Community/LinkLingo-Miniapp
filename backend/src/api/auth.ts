import {MentraAuthError, createMentraAuth, type HonoLikeContext} from "@mentra/auth"

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.mentra.link"
const PROD_JWKS = "https://core.mentraglass.com/.well-known/jwks.json"
const DEV_JWKS = "https://core.dev.us-west-2.mentraglass.com/.well-known/jwks.json"

export function allowUnauth(): boolean {
  return process.env.LINKLINGO_ALLOW_UNAUTH === "true"
}

function jwksCandidates(): string[] {
  const configured = (process.env.MENTRA_AUTH_JWKS_URL ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...configured, PROD_JWKS, DEV_JWKS])]
}

const verifiers = jwksCandidates().map((jwksUrl) => createMentraAuth({packageName: PACKAGE_NAME, jwksUrl}))

export function mentraAuthMiddleware() {
  if (allowUnauth()) {
    return async (c: HonoLikeContext, next: () => Promise<void>) => {
      c.set("mentraAuth", {
        mentraUserId: "local-dev",
        packageName: PACKAGE_NAME,
        claims: {},
      })
      await next()
    }
  }

  return async (c: HonoLikeContext, next: () => Promise<void>) => {
    const header = c.req.header("Authorization")
    let lastError: MentraAuthError | undefined
    for (const auth of verifiers) {
      try {
        c.set("mentraAuth", await auth.verifyAuthHeader(header))
        await next()
        return
      } catch (error) {
        if (error instanceof MentraAuthError) {
          lastError = error
          continue
        }
        throw error
      }
    }
    const message = lastError?.message ?? "miniapp token rejected"
    console.warn(`[auth] 401: ${message} expectedAud=${PACKAGE_NAME}`)
    return c.json({error: message}, 401)
  }
}
