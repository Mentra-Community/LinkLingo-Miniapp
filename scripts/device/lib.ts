import {dump, label, screenshot, tap, tapAt, swipeUp, shell, forceStop, launch, back, waitFor, find} from "./ui"

export const state = JSON.parse(await Bun.file(process.env.DEVICE_STATE_FILE ?? "/tmp/device/state.json").text()) as {
  mandarinUrl: string
  linklingoUrl: string
  ownerCredential: string
  controlUrl: string
}

export const lastPairing = async (): Promise<{secret: string; link: string} | null> =>
  (await fetch(`${state.controlUrl}/last-pairing`)).json() as Promise<{secret: string; link: string} | null>
export const control = (path: string, body?: string) =>
  fetch(`${state.controlUrl}${path}`, {method: body ? "POST" : "GET", body}).then((r) => r.text())
export const sql = async (query: string) => JSON.parse(await control("/sql", query)) as Array<Record<string, any>>
export const mint = async (sub = "device-user") =>
  ((await (await fetch(`${state.controlUrl}/mint?sub=${sub}`)).json()) as {token: string}).token

export const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${state.mandarinUrl}/v1/learning${path}`, {
    method,
    headers: {"authorization": `Bearer ${state.ownerCredential}`, "content-type": "application/json"},
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {status: res.status, body: (await res.json().catch(() => null)) as any}
}

export async function sendEvents(texts: string[], startSeq: number, session = "session-device-aaaa") {
  const token = await mint()
  const base = Date.now() - 60_000
  const events = texts.map((text, i) => ({
    schemaVersion: 1,
    source: "linklingo",
    sourceSessionId: session,
    eventId: `event-device-${startSeq + i}-bbbb`,
    sequence: startSeq + i,
    capturedAt: new Date(base + i * 10_000).toISOString(),
    timezone: "Asia/Shanghai",
    text,
    detectedLanguage: "zh",
    mode: "heard",
    disposition: "heard",
    speakerAttribution: "unknown",
    clientVersion: "1.0.22",
    clientBuildId: "device",
  }))
  const res = await fetch(`${state.linklingoUrl}/api/learning/events`, {
    method: "POST",
    headers: {"authorization": `Bearer ${token}`, "content-type": "application/json"},
    body: JSON.stringify({schemaVersion: 1, events}),
  })
  return {status: res.status, body: await res.json()}
}

/** Notes in AnkiDroid's real collection whose SentenceId field matches. Reads the collection file straight off the emulator. */
export async function ankiNotesFor(sentenceId: string): Promise<Array<{id: string; fields: string; cards: string}>> {
  const dir = "/tmp/device/anki"
  await Bun.spawn([
    "sh",
    "-c",
    `rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && adb -s ${process.env.DEVICE_SERIAL ?? "emulator-5556"} pull /sdcard/AnkiDroid/collection.anki2 . >/dev/null 2>&1; adb -s ${process.env.DEVICE_SERIAL ?? "emulator-5556"} pull /sdcard/AnkiDroid/collection.anki2-wal . >/dev/null 2>&1`,
  ]).exited
  const run = async (q: string) => {
    const p = Bun.spawn(["sqlite3", "-separator", "\t", `${dir}/collection.anki2`, q], {stdout: "pipe", stderr: "pipe"})
    const out = await new Response(p.stdout).text()
    await p.exited
    return out.trim()
  }
  const notes = (await run(`select id, replace(flds, char(31), ' | ') from notes where flds like '%${sentenceId}%'`))
    .split("\n")
    .filter(Boolean)
  const result = []
  for (const line of notes) {
    const [id, fields] = line.split("\t")
    const cards = await run(
      `select group_concat('ord ' || ord || ' deck ' || (select name from decks where id = did), '; ') from cards where nid = ${id}`,
    )
    result.push({id: id!, fields: fields!, cards})
  }
  return result
}

export {dump, label, screenshot, tap, tapAt, swipeUp, shell, forceStop, launch, back, waitFor, find}
