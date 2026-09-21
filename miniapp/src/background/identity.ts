/**
 * Identifiers that let one gloss be followed across the phone, the backend
 * review tape, and the HTTP logs.
 *
 * The phone mints the request id and sends it as `X-Request-Id`. The backend
 * adopts an incoming id, so `ReviewEntry.requestId` becomes an exact join key
 * instead of two ids that have to be matched up by timestamp.
 *
 * The background runs in a bare JS engine, so ids are built from `Math.random`
 * and `Date.now` rather than `crypto.randomUUID`.
 */

/** Inlined by build.ts from miniapp.json. */
export const CLIENT_VERSION = process.env.MENTRA_PUBLIC_LINKLINGO_VERSION || "0.0.0"
/** Commit (or `dev`) the bundle was built from; distinguishes two builds of one version. */
export const CLIENT_BUILD_ID = process.env.MENTRA_PUBLIC_LINKLINGO_BUILD_ID || "dev"

/** New on every background start, so a cold first request is separable from a warm tenth. */
export const SESSION_ID = randomId(10)

let seq = 0

/** Monotonic within the session; request 1 is the cold one. */
export function nextRequestSeq(): number {
  seq += 1
  return seq
}

export function newRequestId(): string {
  return randomId(12)
}

function randomId(length: number): string {
  let out = Date.now().toString(36)
  while (out.length < length) out += Math.random().toString(36).slice(2)
  return out.slice(-length)
}
