/**
 * Real-process integration harness. Starts the actual Mandarin server and the
 * actual LinkLingo backend against a scratch Postgres database and a scratch
 * MinIO bucket, with real Mentra-style JWT verification through a local JWKS.
 * Nothing here is mocked: kill/restart uses SIGKILL on the real processes.
 *
 * Needs `docker compose up -d` in mandarin-app (Postgres :57432, MinIO :59000).
 */
import {randomBytes, randomUUID} from "node:crypto"
import {resolve} from "node:path"

import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3"
import {SQL} from "bun"
import {SignJWT, exportJWK, generateKeyPair, type JWK} from "jose"

export const LINKLINGO_DIR = resolve(import.meta.dir, "../../..")
export const MANDARIN_DIR = resolve(process.env.MANDARIN_APP_DIR ?? resolve(LINKLINGO_DIR, "../mandarin-app"))
export const PG_ADMIN_URL = process.env.E2E_DATABASE_URL ?? "postgres://mandarin:mandarin@localhost:57432/mandarin"
export const S3_ENDPOINT = process.env.E2E_S3_ENDPOINT ?? "http://localhost:59000"
export const PACKAGE_NAME = "com.mentra.link"
export const SERVICE_KEY = "e2e-service-key-with-at-least-32-chars!!"

const handedOut = new Set<number>()

/** A free port that this run has not already given to another process (the OS may reuse a just-closed port). */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const server = Bun.serve({port: 0, fetch: () => new Response("x")})
    const port = server.port!
    server.stop(true)
    if (!handedOut.has(port)) {
      handedOut.add(port)
      return port
    }
  }
  throw new Error("could not find a free port")
}

// ------------------------------------------------------------------ JWKS

export interface TestAuthority {
  url: string
  token(subject: string, opts?: {expiresIn?: string; audience?: string}): Promise<string>
  stop(): void
}

/** Serves a real JWKS and signs EdDSA tokens exactly as Mentra cloud-core would (iss cloud-core, aud = package). */
export async function startAuthority(): Promise<TestAuthority> {
  const {publicKey, privateKey} = await generateKeyPair("EdDSA", {extractable: true})
  const kid = `e2e-${randomBytes(4).toString("hex")}`
  const jwk: JWK = {...(await exportJWK(publicKey)), kid, alg: "EdDSA", use: "sig"}
  const server = Bun.serve({port: 0, fetch: () => Response.json({keys: [jwk]})})
  return {
    url: `http://127.0.0.1:${server.port}/.well-known/jwks.json`,
    async token(subject, opts = {}) {
      return new SignJWT({})
        .setProtectedHeader({alg: "EdDSA", kid})
        .setIssuer("cloud-core")
        .setAudience(opts.audience ?? PACKAGE_NAME)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "1h")
        .sign(privateKey)
    },
    stop: () => server.stop(true),
  }
}

// ------------------------------------------------------------ Fault proxy

export type ProxyMode = "pass" | "down" | "lose_reply"

export interface FaultProxy {
  url: string
  mode: ProxyMode
  /** Requests whose upstream call completed while mode was lose_reply (committed but the caller saw a failure). */
  lostReplies: number
  forwarded: number
  stop(): void
}

/**
 * HTTP reverse proxy that can simulate an outage ("down": upstream never sees
 * the request) or the nasty case ("lose_reply": upstream commits, the caller
 * gets a failure). `match` limits which paths are affected.
 */
export function startFaultProxy(upstream: string, match: (path: string) => boolean = () => true): FaultProxy {
  const state = {mode: "pass" as ProxyMode, lostReplies: 0, forwarded: 0}
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const affected = match(url.pathname)
      if (affected && state.mode === "down") return new Response("proxy: simulated outage", {status: 503})
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
      const headers = new Headers(request.headers)
      headers.delete("host")
      let upstreamResponse: Response
      try {
        upstreamResponse = await fetch(`${upstream}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body,
        })
      } catch {
        // The real upstream is down (for example SIGKILLed): the caller sees a bad gateway.
        return new Response("proxy: upstream unreachable", {status: 502})
      }
      const payload = await upstreamResponse.arrayBuffer()
      state.forwarded++
      if (affected && state.mode === "lose_reply") {
        state.lostReplies++
        return new Response("proxy: reply lost after the upstream committed", {status: 502})
      }
      const outHeaders = new Headers(upstreamResponse.headers)
      outHeaders.delete("content-encoding")
      outHeaders.delete("content-length")
      return new Response(payload, {status: upstreamResponse.status, headers: outHeaders})
    },
  })
  return Object.assign(state, {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  }) as unknown as FaultProxy
}

// ---------------------------------------------------------- Processes

export class Proc {
  private child: ReturnType<typeof Bun.spawn> | null = null
  output = ""
  constructor(
    readonly name: string,
    private readonly cmd: string[],
    private readonly cwd: string,
    private readonly env: Record<string, string>,
    private readonly healthUrl: string,
  ) {}

  async start(timeoutMs = 30_000): Promise<void> {
    this.child = Bun.spawn(this.cmd, {
      cwd: this.cwd,
      env: {...process.env, ...this.env},
      stdout: "pipe",
      stderr: "pipe",
    })
    for (const stream of [this.child.stdout, this.child.stderr] as ReadableStream<Uint8Array>[]) {
      void (async () => {
        const decoder = new TextDecoder()
        for await (const chunk of stream) this.output += decoder.decode(chunk)
        if (this.output.length > 200_000) this.output = this.output.slice(-100_000)
      })()
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null)
        throw new Error(`${this.name} exited early (${this.child.exitCode}):\n${this.output.slice(-2000)}`)
      try {
        if ((await fetch(this.healthUrl)).ok) return
      } catch {
        /* not up yet */
      }
      await Bun.sleep(150)
    }
    throw new Error(`${this.name} did not become healthy:\n${this.output.slice(-2000)}`)
  }

  /** SIGKILL: no graceful shutdown, no flush. This is what a pod eviction or crash looks like. */
  async kill(): Promise<void> {
    if (!this.child) return
    this.child.kill("SIGKILL")
    await this.child.exited
    this.child = null
  }

  async restart(): Promise<void> {
    await this.kill()
    await this.start()
  }
}

// ------------------------------------------------------------------ Stack

export interface Stack {
  mandarin: Proc
  linklingo: Proc
  mandarinUrl: string
  linklingoUrl: string
  /** Proxy between LinkLingo and Mandarin (delivery path). */
  delivery: FaultProxy
  /** Proxy between the phone (test client) and LinkLingo (intake path). */
  intake: FaultProxy
  /** Proxy between the Mandarin phone app (test client) and the Mandarin API, affecting only export receipts. */
  receipts: FaultProxy
  authority: TestAuthority
  databaseUrl: string
  bucket: string
  s3: S3Client
  sql: SQL
  provisionOwner(label: string): Promise<{ownerId: string; credential: string}>
  stop(): Promise<void>
}

export interface StackOptions {
  /** Fixed ports, for runs where a phone must reach the servers (adb reverse). Random otherwise. */
  mandarinPort?: number
  linklingoPort?: number
}

export async function startStack(options: StackOptions = {}): Promise<Stack> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12)
  const dbName = `e2e_${suffix}`
  const bucket = `e2e-${suffix}`

  const admin = new SQL({url: PG_ADMIN_URL, max: 1})
  try {
    await admin.unsafe(`CREATE DATABASE ${dbName}`)
  } catch (error) {
    throw new Error(
      `Postgres is not reachable at ${PG_ADMIN_URL}. Run \`docker compose up -d\` in mandarin-app. (${String(error)})`,
    )
  }
  const databaseUrl = PG_ADMIN_URL.replace(/\/[^/]+$/, `/${dbName}`)

  const s3 = new S3Client({
    region: "us-west-2",
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {accessKeyId: "minioadmin", secretAccessKey: "minioadmin"},
  })
  try {
    await s3.send(new CreateBucketCommand({Bucket: bucket}))
  } catch (error) {
    throw new Error(
      `MinIO is not reachable at ${S3_ENDPOINT}. Run \`docker compose up -d\` in mandarin-app. (${String(error)})`,
    )
  }

  const authority = await startAuthority()
  const [mandarinPort, linklingoPort] = [
    options.mandarinPort ?? (await freePort()),
    options.linklingoPort ?? (await freePort()),
  ]
  const mandarinUrl = `http://127.0.0.1:${mandarinPort}`
  const linklingoUrl = `http://127.0.0.1:${linklingoPort}`
  const delivery = startFaultProxy(mandarinUrl, (path) => path.startsWith("/v1/learning/ingest"))
  const intake = startFaultProxy(linklingoUrl, (path) => path === "/api/learning/events")
  const receipts = startFaultProxy(mandarinUrl, (path) => /\/v1\/learning\/card-drafts\/[^/]+\/exports$/.test(path))

  const mandarin = new Proc(
    "mandarin",
    ["bun", "src/index.ts"],
    resolve(MANDARIN_DIR, "server"),
    {
      PORT: String(mandarinPort),
      APP_TOKEN: "e2e-legacy-app-token-0123456789abcdef",
      OPENAI_API_KEY: "e2e-not-used",
      LEARNING_ENABLED: "true",
      LEARNING_ENV: "e2e",
      DATABASE_URL: databaseUrl,
      LINKLINGO_SERVICE_KEY: SERVICE_KEY,
    },
    `${mandarinUrl}/healthz`,
  )
  const linklingo = new Proc(
    "linklingo",
    ["bun", "backend/src/index.ts"],
    LINKLINGO_DIR,
    {
      PORT: String(linklingoPort),
      LOG_LEVEL: "warn",
      LINKLINGO_LEARNING_ENABLED: "true",
      MANDARIN_LEARNING_URL: delivery.url,
      MANDARIN_SERVICE_KEY: SERVICE_KEY,
      LINKLINGO_LEARNING_CONFIG_KEY: randomBytes(32).toString("base64"),
      LINKLINGO_OUTBOX_BUCKET: bucket,
      LINKLINGO_S3_ENDPOINT: S3_ENDPOINT,
      AWS_REGION: "us-west-2",
      AWS_ACCESS_KEY_ID: "minioadmin",
      AWS_SECRET_ACCESS_KEY: "minioadmin",
      MENTRA_AUTH_JWKS_URL: authority.url,
      PACKAGE_NAME,
      LINKLINGO_ALLOW_UNAUTH: "false",
      LINKLINGO_TAPE_BUCKET: "",
    },
    `${linklingoUrl}/ping`,
  )
  // The LinkLingo config key must survive a restart or the stored credential cannot be decrypted.
  await mandarin.start()
  await linklingo.start()

  const sql = new SQL({url: databaseUrl, max: 2})

  return {
    mandarin,
    linklingo,
    mandarinUrl,
    linklingoUrl,
    delivery,
    intake,
    receipts,
    authority,
    databaseUrl,
    bucket,
    s3,
    sql,
    async provisionOwner(label) {
      // Uses the real provisioning script against the scratch database.
      const proc = Bun.spawn(["bun", "scripts/provision-owner.ts", label], {
        cwd: resolve(MANDARIN_DIR, "server"),
        env: {...process.env, DATABASE_URL: databaseUrl},
        stdout: "pipe",
        stderr: "pipe",
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const ownerId = /owner:\s+(\S+)/.exec(out)?.[1]
      const credential = /credential:\s+(\S+)/.exec(out)?.[1]
      if (!ownerId || !credential) throw new Error(`provision script failed:\n${out}`)
      return {ownerId, credential}
    },
    async stop() {
      await mandarin.kill()
      await linklingo.kill()
      delivery.stop()
      intake.stop()
      receipts.stop()
      authority.stop()
      await sql.close().catch(() => {})
      // Scratch resources are removed so reruns start clean.
      try {
        let token: string | undefined
        do {
          const page = await s3.send(new ListObjectsV2Command({Bucket: bucket, ContinuationToken: token}))
          const keys = (page.Contents ?? []).map((o) => ({Key: o.Key!}))
          if (keys.length) await s3.send(new DeleteObjectsCommand({Bucket: bucket, Delete: {Objects: keys}}))
          token = page.IsTruncated ? page.NextContinuationToken : undefined
        } while (token)
        await s3.send(new DeleteBucketCommand({Bucket: bucket}))
      } catch {
        /* best effort */
      }
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
      await admin.close().catch(() => {})
    },
  }
}

// ---------------------------------------------------------------- Client

export async function http(method: string, url: string, token: string | null, body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: {...(token ? {authorization: `Bearer ${token}`} : {}), "content-type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  })
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return {status: response.status, body: json, text}
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | false | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      last = error
    }
    await Bun.sleep(150)
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ""}`)
}

let sequence = 0
export function learningEvent(over: Record<string, unknown> = {}) {
  const n = sequence++
  return {
    schemaVersion: 1,
    source: "linklingo",
    sourceSessionId: "session-e2e-aaaaaaaa",
    eventId: `event-${Date.now().toString(36)}-${n}-${randomBytes(3).toString("hex")}`,
    sequence: n,
    capturedAt: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    text: "我昨天去工厂了看样品",
    detectedLanguage: "zh",
    mode: "heard",
    disposition: "heard",
    speakerAttribution: "unknown",
    clientVersion: "1.0.22",
    clientBuildId: "e2e",
    ...over,
  }
}
