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

// The phone's live-dev probe aborts GET <base>/miniapp.json after 1.5s.
// This hosted origin's TTFB is above that, so miniapp://dev shows
// "Dev server offline" even when the server is up. miniapp://release
// downloads bundle.zip without that deadline — that is the QR to scan.
const targets = [
  {payload: releaseUrl, file: "linklingo-install-qr.png", label: `private install (v${manifest.version})`},
  {payload: devUrl, file: "linklingo-release-qr.png", label: "live-dev (fails if TTFB > 1.5s)"},
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
      Scan <strong>linklingo-install-qr.png</strong> from Mentra
      <code>Settings → Miniapp Developer Settings → Scan Mini App QR</code>.
      That payload is <code>miniapp://release</code> — it downloads the zip.
      Do not scan <code>https://apps.mentra.glass/apps/${manifest.packageName}</code>
      (old Cloud app) and do not use the live-dev QR unless the origin answers
      <code>/miniapp.json</code> in under 1.5s.
    </p>
    <section>
      <h2>Install this one</h2>
      <p>Downloads v${manifest.version} onto the phone. No 1.5s live probe.</p>
      <img src="linklingo-install-qr.png" alt="Release install QR" />
      <p><code>${releaseUrl}</code></p>
    </section>
    <section>
      <h2>Live-dev (usually times out on this host)</h2>
      <p>Mentra aborts the manifest fetch at 1.5s. This origin is slower, so you get “Dev server offline”.</p>
      <img src="linklingo-release-qr.png" alt="Live-dev QR" />
      <p><code>${devUrl}</code></p>
    </section>
  </body>
</html>
`,
)

console.log(`\nWrote linklingo-install-qr.png, linklingo-release-qr.png, linklingo-install-qr.html (base: ${base})`)
