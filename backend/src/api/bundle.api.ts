/**
 * Hosted miniapp bundle — the surface the phone re-checks on every launch.
 *
 * The Mentra App treats any HTTP(S) base that answers `GET <base>/miniapp.json`
 * as a loadable miniapp. Each launch it re-reads the manifest, loads
 * `<base>/dist/<entry.background>` and `<base>/dist/<entry.ui>` live, and
 * caches `<base>/bundle.zip` on disk so the home tile still opens when this
 * service is unreachable. Serving those paths from the deployed backend makes a
 * push to `main` the whole release: the installed tile runs the new code the
 * next time it is opened, with no rescan and no laptop.
 *
 * On-disk layout, baked by docker/Dockerfile (override the root with
 * MINIAPP_BUNDLE_DIR to serve a local `bun run miniapp:build` instead):
 *
 *   <root>/dist/miniapp.json
 *   <root>/dist/icon.png
 *   <root>/dist/background/index.js
 *   <root>/dist/ui/index.html + hashed chunks
 *   <root>/bundle.zip
 *
 * A missing root is not an error: a backend-only image simply answers 404 here.
 */

import {Hono} from "hono"
import {resolve, sep} from "path"

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
}

const MANIFEST_PATH = "dist/miniapp.json"
const ICON_PATH = "dist/icon.png"
const ZIP_PATH = "bundle.zip"

/** Read the root per call so tests and local runs can repoint it. */
function bundleRoot(): string {
  return resolve(process.cwd(), process.env.MINIAPP_BUNDLE_DIR ?? "miniapp-bundle")
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".")
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase()
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}

/**
 * Resolve `relPath` inside the bundle root, refusing anything that escapes it.
 * The phone only ever asks for fixed paths, but `dist/*` is caller-controlled
 * on a public endpoint.
 */
function resolveInsideRoot(relPath: string): string | null {
  const root = bundleRoot()
  const abs = resolve(root, relPath)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

async function serveBundleFile(relPath: string): Promise<Response> {
  const abs = resolveInsideRoot(relPath)
  if (!abs) return Response.json({error: "Not found"}, {status: 404})

  const file = Bun.file(abs)
  if (!(await file.exists())) {
    return Response.json({error: "Not found", path: relPath}, {status: 404})
  }

  return new Response(file, {
    headers: {
      "content-type": contentTypeFor(abs),
      // The install is only ever as fresh as the last fetch, so nothing in the
      // path may pin an old manifest or entry chunk.
      "cache-control": "no-store",
    },
  })
}

export interface HostedBundleStatus {
  hosted: boolean
  packageName: string | null
  version: string | null
  /** Backend origin inlined into the hosted bundle at image build time. */
  backendUrl: string | null
}

let cachedStatus: HostedBundleStatus | null = null

/**
 * Manifest identity of the hosted bundle, for /healthz. The bundle is baked
 * into an immutable image, so a successful read is cached for the pod's life.
 */
export async function hostedBundleStatus(): Promise<HostedBundleStatus> {
  if (cachedStatus) return cachedStatus

  const backendUrl = process.env.MINIAPP_BUNDLE_BACKEND_URL ?? null
  const abs = resolveInsideRoot(MANIFEST_PATH)
  if (!abs) return {hosted: false, packageName: null, version: null, backendUrl}

  try {
    const manifest = (await Bun.file(abs).json()) as {packageName?: string; version?: string}
    cachedStatus = {
      hosted: true,
      packageName: manifest.packageName ?? null,
      version: manifest.version ?? null,
      backendUrl,
    }
    return cachedStatus
  } catch {
    return {hosted: false, packageName: null, version: null, backendUrl}
  }
}

export const bundleApi = new Hono()

// The CLI dev server answers the manifest for the bare base too; match it so a
// developer hitting the base URL in a browser sees what the phone sees.
bundleApi.get("/", () => serveBundleFile(MANIFEST_PATH))
bundleApi.get("/miniapp.json", () => serveBundleFile(MANIFEST_PATH))
bundleApi.get("/icon.png", () => serveBundleFile(ICON_PATH))
bundleApi.get("/bundle.zip", () => serveBundleFile(ZIP_PATH))
// `entry.*` in the manifest are bundle-root paths; the phone prefixes `dist/`
// for live loads, exactly like the LAN dev server's project-root layout.
bundleApi.get("/dist/:path{.+}", (c) => serveBundleFile(`dist/${c.req.param("path")}`))
