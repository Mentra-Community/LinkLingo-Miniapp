/**
 * Two-output production build: background IIFE + UI WebView bundle.
 * MENTRA_PUBLIC_* env vars are inlined; secrets must stay on the backend.
 */

import {copyFile, rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const PUBLIC_VARS = ["MENTRA_PUBLIC_LINKLINGO_BACKEND_URL"] as const

const define: Record<string, string> = {}
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
console.log("staged miniapp.json + icon.png into dist/")
