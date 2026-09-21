/**
 * Two-output production build: background IIFE + UI WebView bundle.
 * MENTRA_PUBLIC_* env vars are inlined; secrets must stay on the backend.
 */

import {copyFile, rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const PUBLIC_VARS = [
  "MENTRA_PUBLIC_LINKLINGO_BACKEND_URL",
  "MENTRA_PUBLIC_LINKLINGO_LOG_LEVEL",
] as const

/**
 * Build identity, inlined so every gloss can say which bundle produced it.
 * Without it a rebuilt 1.0.16 is indistinguishable from the original in the
 * latency baseline. `build-id.txt` is stamped by the deploy workflow; the
 * committed copy says "dev", which means "use the working tree's git SHA"
 * (available locally, absent inside the image).
 */
async function resolveBuildId(): Promise<string> {
  const explicit = process.env.MENTRA_PUBLIC_LINKLINGO_BUILD_ID?.trim()
  if (explicit) return explicit

  const stamp = Bun.file("../build-id.txt")
  if (await stamp.exists()) {
    const value = (await stamp.text()).trim()
    if (value && value !== "dev") return value
  }

  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {stderr: "ignore"})
    const sha = new TextDecoder().decode(git.stdout).trim()
    if (git.exitCode === 0 && sha) return sha
  } catch {
    // No git in the build image; "dev" is the honest answer.
  }
  return "dev"
}

const manifest = (await Bun.file("./miniapp.json").json()) as {version?: string}

const define: Record<string, string> = {
  "process.env.MENTRA_PUBLIC_LINKLINGO_VERSION": JSON.stringify(manifest.version ?? "0.0.0"),
  "process.env.MENTRA_PUBLIC_LINKLINGO_BUILD_ID": JSON.stringify(await resolveBuildId()),
}
for (const k of PUBLIC_VARS) {
  define[`process.env.${k}`] = JSON.stringify(process.env[k] ?? "")
}
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MENTRA_PUBLIC_") && typeof v === "string") {
    define[`process.env.${k}`] = JSON.stringify(v)
  }
}

const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define,
})
if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const tailwind = (await import("bun-plugin-tailwind")).default

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [tailwind],
  minify: true,
  define,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

await copyFile("./miniapp.json", `${distDir}/miniapp.json`)
await copyFile("./icon.png", `${distDir}/icon.png`)
console.log(
  `staged miniapp.json + icon.png into dist/ (version=${manifest.version} build=${JSON.parse(define["process.env.MENTRA_PUBLIC_LINKLINGO_BUILD_ID"]!)})`,
)
