/**
 * Generate install QRs for the *hosted* bundle (see README → "Permanent install
 * with auto-update"). Unlike the QRs `mentra-miniapp dev` / `release` print,
 * these point at a deployed origin, so they never go stale when a laptop's
 * Wi-Fi IP changes and can be saved once and reused forever.
 *
 *   bun run qr
 *   bun run qr -- --base https://linklingo-miniapp-prod.mentraglass.com/miniapp
 *
 * Two payloads, because they install two different ways:
 *
 *   dev     — registers the hosted base as the miniapp's source. The Mentra App
 *             re-reads the manifest on every launch, runs the current hosted
 *             build, and refreshes an on-disk copy for offline launches. This is
 *             the auto-updating install.
 *   release — one-shot download into `lmas/<package>/<version>/`. Never phones
 *             home again, so a new version needs a rescan.
 */

import {resolve} from "path"

// The `qrcode` dep belongs to the vendored CLI; reach into it rather than
// adding a root dependency for a local-only script.
import QRCode from "../vendor/miniapp-cli/node_modules/qrcode"

const DEFAULT_BASE = "https://linklingo-miniapp-dev.mentraglass.com/miniapp"
const repoRoot = resolve(import.meta.dir, "..")

function readBase(): string {
  const flag = process.argv.indexOf("--base")
  const value =
    (flag !== -1 ? process.argv[flag + 1] : undefined) ?? process.env.LINKLINGO_MINIAPP_BASE_URL ?? DEFAULT_BASE
  return value.replace(/\/+$/, "")
}

const base = readBase()
const manifest = (await Bun.file(resolve(repoRoot, "miniapp/miniapp.json")).json()) as {
  packageName: string
  version: string
  name: string
}

const common = `url=${encodeURIComponent(base)}&package=${encodeURIComponent(manifest.packageName)}&name=${encodeURIComponent(manifest.name)}`
const devUrl = `miniapp://dev?${common}`
const releaseUrl = `miniapp://release?${common}&version=${encodeURIComponent(manifest.version)}`

const targets = [
  {payload: devUrl, file: "linklingo-install-qr.png", label: "auto-updating install"},
  {payload: releaseUrl, file: "linklingo-release-qr.png", label: `one-shot install (v${manifest.version})`},
]

for (const {payload, file, label} of targets) {
  await QRCode.toFile(resolve(repoRoot, file), payload, {width: 720, margin: 2})
  console.log(`\n${manifest.name} — ${label}`)
  console.log(await QRCode.toString(payload, {type: "terminal", small: true}))
  console.log(payload)
}

await Bun.write(
  resolve(repoRoot, "linklingo-install-qr.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${manifest.name} install</title>
    <style>
      body { font-family: system-ui; margin: 0 auto; max-width: 900px; padding: 32px; }
      section { border-top: 1px solid #ddd; padding-top: 24px; }
      img { width: 340px; height: 340px; }
      code { word-break: break-all; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>${manifest.name} <small>${manifest.version}</small></h1>
    <p>
      Mentra App → Settings → Developer settings → Mini App Development → Scan Mini App QR Code.
      Both QRs install from <code>${base}</code> — no laptop, no shared Wi-Fi.
    </p>
    <section>
      <h2>Auto-updating install</h2>
      <p>Runs the latest deployed build on every launch; keeps an offline copy. Scan this one.</p>
      <img src="linklingo-install-qr.png" alt="Auto-updating install QR" />
      <p><code>${devUrl}</code></p>
    </section>
    <section>
      <h2>One-shot install</h2>
      <p>Downloads v${manifest.version} once and never checks again. Rescan after a version bump.</p>
      <img src="linklingo-release-qr.png" alt="One-shot install QR" />
      <p><code>${releaseUrl}</code></p>
    </section>
  </body>
</html>
`,
)

console.log(`\nWrote linklingo-install-qr.png, linklingo-release-qr.png, linklingo-install-qr.html (base: ${base})`)
