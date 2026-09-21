/**
 * Upload a Cloud V2 *draft* release for this miniapp.
 *
 * Intentionally does not submit for review, publish, or add the release to
 * preinstall. A draft stays on the developer org's console only — it is not
 * listed in the public store and phones cannot download the bundle by asset id.
 *
 *   bun run publish:draft
 *
 * Auth: MENTRA_CLI_TOKEN or MENTRA_ADMIN_TOKEN.
 * Core: MENTRA_CORE_URL (default: Cloud V2 dev).
 */
import {createHash, createPrivateKey, generateKeyPairSync, sign} from "node:crypto"
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {homedir} from "node:os"
import {join, resolve} from "node:path"
import {$} from "bun"

const repoRoot = resolve(import.meta.dir, "..")
const miniappDir = join(repoRoot, "miniapp")
const DEFAULT_CORE = "https://core.dev.us-west-2.mentraglass.com"
const BACKEND_URL = process.env.MENTRA_PUBLIC_LINKLINGO_BACKEND_URL || "https://linklingo-miniapp-dev.mentraglass.com"

type Manifest = {
  packageName: string
  version: string
  name: string
  description?: string
}

type SigningKey = {
  signingKeyId: string
  publicKeyJwk: Record<string, unknown>
  privateKeyJwk: Record<string, unknown>
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function coreUrl(): string {
  return (process.env.MENTRA_CORE_URL || DEFAULT_CORE).replace(/\/+$/, "")
}

function token(): string {
  const value = process.env.MENTRA_CLI_TOKEN || process.env.MENTRA_ADMIN_TOKEN
  if (!value) {
    throw new Error("Set MENTRA_CLI_TOKEN or MENTRA_ADMIN_TOKEN before bun run publish:draft")
  }
  return value
}

function keyPath(core: string): string {
  const dir = join(homedir(), ".mentra", "cli-v2")
  mkdirSync(dir, {recursive: true, mode: 0o700})
  const slug = Buffer.from(core).toString("base64url")
  return join(dir, `linklingo-signing-key-${slug}.json`)
}

async function coreRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${coreUrl()}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token()}`,
      ...(init?.body ? {"content-type": "application/json"} : {}),
      ...init?.headers,
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${init?.method || "GET"} ${path} → ${response.status} ${text.slice(0, 400)}`)
  }
  return text ? (JSON.parse(text) as T) : ({} as T)
}

async function ensureSigningKey(): Promise<SigningKey> {
  const path = keyPath(coreUrl())
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as SigningKey
    const remote = await coreRequest<{keys: Array<{id: string; status: string}>}>("/api/console/signing-keys")
    if (remote.keys.some((key) => key.id === stored.signingKeyId && key.status === "active")) {
      return stored
    }
  }

  const pair = generateKeyPairSync("ed25519")
  const publicKeyJwk = pair.publicKey.export({format: "jwk"}) as Record<string, unknown>
  const privateKeyJwk = pair.privateKey.export({format: "jwk"}) as Record<string, unknown>
  const created = await coreRequest<{key: {id: string}}>("/api/console/signing-keys", {
    method: "POST",
    body: JSON.stringify({publicKeyJwk}),
  })
  const stored: SigningKey = {
    signingKeyId: created.key.id,
    publicKeyJwk,
    privateKeyJwk,
  }
  writeFileSync(path, `${JSON.stringify(stored)}\n`, {mode: 0o600})
  return stored
}

function signPayload(privateKeyJwk: Record<string, unknown>, payload: unknown): string {
  const privateKey = createPrivateKey({key: privateKeyJwk, format: "jwk"} as never)
  return sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url")
}

async function pack(): Promise<string> {
  const manifest = (await Bun.file(join(miniappDir, "miniapp.json")).json()) as Manifest
  const zipPath = join(miniappDir, "build", `${manifest.packageName}-${manifest.version}.zip`)
  if (!process.argv.includes("--no-pack")) {
    await $`${process.execPath} run pack`.cwd(repoRoot).env({
      ...process.env,
      MENTRA_PUBLIC_LINKLINGO_BACKEND_URL: BACKEND_URL,
    })
  }
  if (!existsSync(zipPath)) {
    throw new Error(`Release zip missing: ${zipPath}`)
  }
  return zipPath
}

const zipPath = await pack()
const manifest = (await Bun.file(join(miniappDir, "miniapp.json")).json()) as Manifest
const bundle = readFileSync(zipPath)
const signingKey = await ensureSigningKey()
const payload = {
  packageName: manifest.packageName,
  version: manifest.version,
  bundleSha256: sha256Hex(bundle),
  manifestSha256: sha256Hex(Buffer.from(canonicalJson(manifest))),
  createdAt: new Date().toISOString(),
}

const created = await coreRequest<{
  release: {id: string; version: string; status: string; bundleSizeBytes: number | null; bundleSha256: string | null}
}>(`/api/console/apps/${encodeURIComponent(manifest.packageName)}/releases`, {
  method: "POST",
  body: JSON.stringify({
    packageName: manifest.packageName,
    version: manifest.version,
    manifest,
    bundleBase64: bundle.toString("base64"),
    fileName: `${manifest.packageName}-${manifest.version}.zip`,
    signedBundle: {
      signingKeyId: signingKey.signingKeyId,
      payload,
      signature: signPayload(signingKey.privateKeyJwk, payload),
    },
  }),
})

const release = created.release
if (release.status !== "draft") {
  throw new Error(`Refusing unexpected release status ${release.status}; expected draft`)
}

const consoleHost = coreUrl().includes("core.dev.")
  ? "https://console2.dev.mentraglass.com"
  : coreUrl().includes("core.staging.")
    ? "https://console2.staging.mentraglass.com"
    : "https://console2.mentraglass.com"

console.log(`Draft only: ${manifest.packageName}@${release.version}`)
console.log(`Release: ${release.id}`)
console.log(`Status: ${release.status}`)
console.log(`Bundle: ${Math.round((release.bundleSizeBytes ?? bundle.length) / 1024)} KB`)
console.log(`SHA-256: ${release.bundleSha256 ?? payload.bundleSha256}`)
console.log(`Console: ${consoleHost}/apps/${manifest.packageName}`)
console.log("Not submitted, not published, not in preinstall.")
