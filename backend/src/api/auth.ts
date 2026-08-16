import {createMentraAuth, type HonoLikeContext, type MentraAuthError} from "@mentra/auth"

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? "com.mentra.link"

const mentraAuth = createMentraAuth({packageName: PACKAGE_NAME})

export function allowUnauth(): boolean {
  return process.env.LINKLINGO_ALLOW_UNAUTH === "true"
}

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
  return mentraAuth.hono({
    onUnauthorized: (error: MentraAuthError, c: HonoLikeContext) => {
      console.warn(`[auth] 401: ${error.message} expectedAud=${PACKAGE_NAME}`)
      return c.json({error: error.message}, 401)
    },
  })
}
