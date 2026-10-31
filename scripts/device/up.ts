/**
 * Brings up the real backends for a phone/emulator run and keeps them up.
 *
 *   bun scripts/device/up.ts          (in LinkLingo-Miniapp; needs `docker compose up -d` in mandarin-app)
 *
 * Real Mandarin server + real LinkLingo backend + Postgres + MinIO + a real JWKS, on fixed ports so an
 * emulator can reach them with `adb reverse`. A small control server (port 3713) lets the driver mint a
 * Mentra-style token, read state, and SIGKILL / restart either backend, which is how restarts are exercised
 * while the app is mid-flow.
 */
import {writeFileSync} from "node:fs"

import {startStack} from "../e2e/lib/stack"

// The phone talks to a recording proxy on 3711; the real Mandarin server sits behind it on 3714.
const PHONE_PORT = Number(process.env.DEVICE_MANDARIN_PORT ?? 3711)
const MANDARIN_PORT = Number(process.env.DEVICE_MANDARIN_REAL_PORT ?? 3714)
const LINKLINGO_PORT = Number(process.env.DEVICE_LINKLINGO_PORT ?? 3712)
const CONTROL_PORT = Number(process.env.DEVICE_CONTROL_PORT ?? 3713)
const STATE_FILE = process.env.DEVICE_STATE_FILE ?? "/tmp/device/state.json"

const stack = await startStack({mandarinPort: MANDARIN_PORT, linklingoPort: LINKLINGO_PORT})
const owner = await stack.provisionOwner("Device test")

let lastPairing: unknown = null
/**
 * Passes the phone's requests through unchanged and remembers the last pairing code Mandarin returned.
 * uiautomator cannot read a screen that re-renders every second (the code's countdown) on an overloaded
 * machine, so the driver reads the code the phone was given from here instead. It is the same body the app shows.
 */
const phoneProxy = Bun.serve({
  port: PHONE_PORT,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    const headers = new Headers(request.headers)
    headers.delete("host")
    let upstream: Response
    try {
      upstream = await fetch(`${stack.mandarinUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body,
      })
    } catch {
      return new Response(JSON.stringify({error: "storage_unavailable", message: "upstream down"}), {
        status: 503,
        headers: {"content-type": "application/json"},
      })
    }
    const payload = await upstream.arrayBuffer()
    if (request.method === "POST" && url.pathname === "/v1/learning/pairing" && upstream.ok) {
      try {
        lastPairing = JSON.parse(new TextDecoder().decode(payload))
      } catch {
        /* not json */
      }
    }
    const out = new Headers(upstream.headers)
    out.delete("content-encoding")
    out.delete("content-length")
    return new Response(payload, {status: upstream.status, headers: out})
  },
})

const state = {
  mandarinUrl: `http://127.0.0.1:${PHONE_PORT}`,
  realMandarinUrl: stack.mandarinUrl,
  linklingoUrl: stack.linklingoUrl,
  ownerId: owner.ownerId,
  ownerCredential: owner.credential,
  databaseUrl: stack.databaseUrl,
  bucket: stack.bucket,
  controlUrl: `http://127.0.0.1:${CONTROL_PORT}`,
}
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

const control = Bun.serve({
  port: CONTROL_PORT,
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/state") return Response.json(state)
      if (url.pathname === "/last-pairing") return Response.json(lastPairing)
      if (url.pathname === "/mint")
        return Response.json({token: await stack.authority.token(url.searchParams.get("sub") ?? "device-user")})
      if (url.pathname === "/mandarin/kill") return (await stack.mandarin.kill(), Response.json({ok: true}))
      if (url.pathname === "/mandarin/start") return (await stack.mandarin.start(), Response.json({ok: true}))
      if (url.pathname === "/linklingo/kill") return (await stack.linklingo.kill(), Response.json({ok: true}))
      if (url.pathname === "/linklingo/start") return (await stack.linklingo.start(), Response.json({ok: true}))
      if (url.pathname === "/sql") {
        const rows = await stack.sql.unsafe(await request.text())
        return Response.json(rows)
      }
      return new Response("not found", {status: 404})
    } catch (error) {
      return new Response(String(error), {status: 500})
    }
  },
})

console.log(
  `device stack ready: phone-facing mandarin ${state.mandarinUrl} (real ${state.realMandarinUrl}), linklingo ${state.linklingoUrl}, control ${state.controlUrl}`,
)

const shutdown = async () => {
  control.stop(true)
  phoneProxy.stop(true)
  await stack.stop()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
await new Promise(() => {})
