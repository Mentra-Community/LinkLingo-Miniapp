/** Minimal adb + uiautomator helpers for driving the Mandarin app on an emulator. */
import {mkdirSync} from "node:fs"

export const SERIAL = process.env.DEVICE_SERIAL ?? "emulator-5556"
export const SHOTS = process.env.DEVICE_SHOTS ?? "/tmp/device/shots"
mkdirSync(SHOTS, {recursive: true})

export async function adb(args: string[], opts: {stdin?: string; raw?: boolean} = {}): Promise<string> {
  const proc = Bun.spawn(["adb", "-s", SERIAL, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : "ignore",
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return opts.raw ? out : (out + err).trim()
}

export const shell = (command: string) => adb(["shell", command])

export interface UiNode {
  text: string
  desc: string
  id: string
  cls: string
  clickable: boolean
  enabled: boolean
  checked: boolean
  bounds: {x1: number; y1: number; x2: number; y2: number}
  cx: number
  cy: number
}

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#10;/g, "\n")

export async function dump(): Promise<UiNode[]> {
  // Streaming the dump through exec-out is about five times faster than writing a file and reading it back,
  // which matters on a loaded machine where each extra adb round trip costs seconds.
  let xml = ""
  // uiautomator waits for the UI to go idle. A screen that re-renders constantly (the pairing code countdown) on a
  // loaded machine can fail with "could not get idle state"; that is retried rather than read as an empty screen.
  for (let attempt = 0; attempt < 3; attempt++) {
    xml = await adb(["exec-out", "uiautomator", "dump", "/dev/tty"], {raw: true})
    if (xml.includes("<hierarchy")) break
    await Bun.sleep(500)
  }
  const nodes: UiNode[] = []
  for (const match of xml.matchAll(/<node ([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {}
    for (const m of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]!] = decode(m[2]!)
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "")
    if (!b) continue
    const [x1, y1, x2, y2] = [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] as [
      number,
      number,
      number,
      number,
    ]
    nodes.push({
      text: attrs.text ?? "",
      desc: attrs["content-desc"] ?? "",
      id: attrs["resource-id"] ?? "",
      cls: attrs.class ?? "",
      clickable: attrs.clickable === "true",
      enabled: attrs.enabled !== "false",
      checked: attrs.checked === "true",
      bounds: {x1, y1, x2, y2},
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
    })
  }
  return nodes
}

export const label = (n: UiNode) => n.text || n.desc

export function matches(node: UiNode, what: string | RegExp): boolean {
  const l = label(node)
  return typeof what === "string" ? l === what || l.includes(what) : what.test(l)
}

export async function find(what: string | RegExp, nodes?: UiNode[]): Promise<UiNode | undefined> {
  const all = nodes ?? (await dump())
  return all.find((n) => matches(n, what) && n.bounds.x2 > n.bounds.x1)
}

export async function visible(): Promise<string[]> {
  return (await dump()).map(label).filter(Boolean)
}

export async function tapAt(x: number, y: number) {
  await shell(`input tap ${x} ${y}`)
}

export async function tap(what: string | RegExp, opts: {timeoutMs?: number; index?: number} = {}): Promise<UiNode> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    const matchesAll = (await dump()).filter((n) => matches(n, what) && n.bounds.x2 > n.bounds.x1)
    const node = matchesAll[opts.index ?? 0]
    if (node) {
      await tapAt(node.cx, node.cy)
      await Bun.sleep(600)
      return node
    }
    await Bun.sleep(500)
  }
  throw new Error(`could not find "${String(what)}" to tap. Visible: ${JSON.stringify((await visible()).slice(0, 40))}`)
}

export async function waitFor(what: string | RegExp, timeoutMs = 20_000): Promise<UiNode> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const node = await find(what)
    if (node) return node
    await Bun.sleep(500)
  }
  throw new Error(`timed out waiting for "${String(what)}". Visible: ${JSON.stringify((await visible()).slice(0, 40))}`)
}

export async function gone(what: string | RegExp, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await find(what))) return
    await Bun.sleep(500)
  }
  throw new Error(`"${String(what)}" is still on screen`)
}

/** Types into the focused field. Spaces are escaped for `input text`; only ASCII is supported. */
export async function typeText(text: string) {
  if (/[^\x20-\x7e]/.test(text)) throw new Error("typeText supports ASCII only; use paste for Chinese")
  await shell(`input text '${text.replace(/ /g, "%s").replace(/'/g, "'\\''")}'`)
  await Bun.sleep(300)
}

export const key = (code: string | number) => shell(`input keyevent ${code}`)
export const back = () => key(4)

export async function swipeUp() {
  await shell("input swipe 540 1700 540 700 300")
  await Bun.sleep(500)
}

export async function screenshot(name: string): Promise<string> {
  const file = `${SHOTS}/${name}.png`
  const png = await adb(["exec-out", "screencap", "-p"], {raw: true})
  // adb text decoding corrupts binary; re-run through the shell redirect instead
  void png
  const proc = Bun.spawn(["sh", "-c", `adb -s ${SERIAL} exec-out screencap -p > ${file}`])
  await proc.exited
  return file
}

/** Sets the emulator clipboard-free way to enter Chinese: broadcast text through the app's own paste is not available, so tests avoid typing Chinese. */
export async function launch(pkg = "com.nicolo.mandarin") {
  await shell(`am start -n ${pkg}/.MainActivity`)
  await Bun.sleep(2500)
}

export async function forceStop(pkg = "com.nicolo.mandarin") {
  await shell(`am force-stop ${pkg}`)
}

/** Taps the lowest matching node on screen (a decision button, not a status chip of the same name). */
export async function tapLast(what: string | RegExp, timeoutMs = 15_000): Promise<UiNode> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const all = (await dump()).filter((n) => matches(n, what) && n.bounds.x2 > n.bounds.x1 && n.clickable)
    const node = all.sort((a, b) => b.cy - a.cy)[0]
    if (node) {
      await tapAt(node.cx, node.cy)
      await Bun.sleep(900)
      return node
    }
    await Bun.sleep(500)
  }
  throw new Error(`could not find clickable "${String(what)}"`)
}

export async function scrollUntil(what: string | RegExp, maxSwipes = 8, settleMs = 6000): Promise<UiNode> {
  for (let i = 0; i < maxSwipes; i++) {
    // The accessibility tree can lag a rendering change on a loaded machine, so look for a few seconds before moving on.
    const deadline = Date.now() + (i === 0 ? settleMs : 1500)
    do {
      const node = await find(what)
      if (node && node.cy < 2150) return node
      await Bun.sleep(400)
    } while (Date.now() < deadline)
    await swipeUp()
  }
  throw new Error(`"${String(what)}" never came into view`)
}

/** Taps the topmost matching clickable node (the first line's decision button). */
export async function tapFirst(what: string | RegExp, timeoutMs = 15_000): Promise<UiNode> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const all = (await dump()).filter((n) => matches(n, what) && n.bounds.x2 > n.bounds.x1 && n.clickable)
    const node = all.sort((a, b) => a.cy - b.cy)[0]
    if (node) {
      await tapAt(node.cx, node.cy)
      await Bun.sleep(1500)
      return node
    }
    await Bun.sleep(500)
  }
  throw new Error(`could not find clickable "${String(what)}"`)
}

/** Scrolls until a clickable node with this label is on screen (a button, not a status chip of the same name). */
export async function scrollToClickable(what: string | RegExp, maxSwipes = 8): Promise<UiNode> {
  for (let i = 0; i < maxSwipes; i++) {
    const deadline = Date.now() + (i === 0 ? 5000 : 1500)
    do {
      const node = (await dump()).find(
        (n) => matches(n, what) && n.clickable && n.bounds.x2 > n.bounds.x1 && n.cy < 2150,
      )
      if (node) return node
      await Bun.sleep(400)
    } while (Date.now() < deadline)
    await swipeUp()
  }
  throw new Error(`no clickable "${String(what)}" came into view`)
}
