import {afterAll, beforeAll, describe, expect, test} from "bun:test"
import {mkdtempSync, rmSync} from "fs"
import {tmpdir} from "os"
import {join} from "path"

import {bundleApi} from "./bundle.api"

const root = mkdtempSync(join(tmpdir(), "linklingo-bundle-"))
const previousDir = process.env.MINIAPP_BUNDLE_DIR

beforeAll(async () => {
  process.env.MINIAPP_BUNDLE_DIR = root
  await Bun.write(join(root, "dist/miniapp.json"), JSON.stringify({packageName: "com.mentra.link", version: "9.9.9"}))
  await Bun.write(join(root, "dist/background/index.js"), "globalThis.__linklingo = 1")
  await Bun.write(join(root, "dist/ui/index.html"), "<!doctype html><html></html>")
  await Bun.write(join(root, "bundle.zip"), "PK\u0003\u0004")
  await Bun.write(join(root, "..", "outside-the-root.txt"), "secret")
})

afterAll(() => {
  if (previousDir === undefined) delete process.env.MINIAPP_BUNDLE_DIR
  else process.env.MINIAPP_BUNDLE_DIR = previousDir
  rmSync(root, {recursive: true, force: true})
  rmSync(join(root, "..", "outside-the-root.txt"), {force: true})
})

describe("hosted bundle", () => {
  test("serves the manifest the phone probes for, uncached", async () => {
    const res = await bundleApi.request("/miniapp.json")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({packageName: "com.mentra.link", version: "9.9.9"})
  })

  test("serves the bare base as the manifest, like the LAN dev server", async () => {
    const res = await bundleApi.request("/")
    expect(res.status).toBe(200)
    expect(((await res.json()) as {version: string}).version).toBe("9.9.9")
  })

  test("serves live entry files under dist/ with usable content types", async () => {
    const background = await bundleApi.request("/dist/background/index.js")
    expect(background.status).toBe(200)
    expect(background.headers.get("content-type")).toContain("application/javascript")

    const ui = await bundleApi.request("/dist/ui/index.html")
    expect(ui.status).toBe(200)
    expect(ui.headers.get("content-type")).toContain("text/html")
  })

  test("serves the offline snapshot zip", async () => {
    const res = await bundleApi.request("/bundle.zip")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/zip")
  })

  test("404s a missing file instead of failing the request", async () => {
    const res = await bundleApi.request("/dist/ui/nope.js")
    expect(res.status).toBe(404)
  })

  test("refuses paths that escape the bundle root", async () => {
    for (const path of ["/dist/../../outside-the-root.txt", "/dist/..%2F..%2Foutside-the-root.txt"]) {
      const res = await bundleApi.request(path)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain("secret")
    }
  })
})
