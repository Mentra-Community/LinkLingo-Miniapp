/**
 * Stage 1 gate on a real emulator with real AnkiDroid, driven through the app's own screens.
 *
 *   bun scripts/device/up.ts &          # fresh scratch database, fixed ports
 *   (Metro for the app is running; see scripts/device/README.md)
 *   bun scripts/device/stage1.ts
 *
 * One conversation arrives through the real LinkLingo backend, the learner decides speaker and correction in the
 * app, creates a card, saves it, and the result is checked in AnkiDroid's OWN collection file. Then the hard case:
 * the server is down while the card is saved and the app is killed right after, and the receipt must still
 * reconcile later with exactly one note.
 *
 * Not covered here, and said so: LinkLingo's phone-side capture (needs the glasses microphone and MentraOS) and
 * typing Chinese (adb cannot), so the proposed correction is created through the API, as analysis would.
 */
import {ankiNotesFor, api, control, lastPairing, mint, sendEvents, sql, state} from "./lib"
import {
  back,
  dump,
  find,
  forceStop,
  label,
  launch,
  screenshot,
  scrollToClickable,
  scrollUntil,
  shell,
  tap,
  tapAt,
  tapFirst,
  tapLast,
  typeText,
  waitFor,
} from "./ui"

const SERIAL = process.env.DEVICE_SERIAL ?? "emulator-5556"
// The AnkiDroid test collection persists between runs, and the app rightly refuses a second card for the same
// sentence, so every run uses sentences of its own.
const TAG = String(Date.now()).slice(-4)
const S1 = `我昨天去工厂了看样品${TAG}`
const S1_EXCERPT = `去工厂了看样品${TAG}`
const S1_FIX = `去工厂看了样品${TAG}`
const S1_EN = `Yesterday I went to the factory to look at samples ${TAG}.`
const SESSION = `session-stage1-${TAG}`
const S2 = `我想订一张去深圳的机票${TAG}`
const S2_EXCERPT = `去深圳的机票${TAG}`
const S2_FIX = `到深圳的机票${TAG}`
const S2_EN = `I want to book a ticket to Shenzhen ${TAG}.`
let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const step = (msg: string) => console.log(`\n== ${msg}`)

async function ensureDebugHost() {
  const xml = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name="debug_http_host">localhost:8082</string>\n</map>\n`
  await Bun.write("/tmp/device/prefs.xml", xml)
  await Bun.spawn(["adb", "-s", SERIAL, "push", "/tmp/device/prefs.xml", "/data/local/tmp/prefs.xml"]).exited
  await shell(
    "run-as com.nicolo.mandarin mkdir -p shared_prefs && run-as com.nicolo.mandarin cp /data/local/tmp/prefs.xml shared_prefs/com.nicolo.mandarin_preferences.xml",
  )
}

const CONVERSATION_ROW = /^Conversation \d\d:\d\d, /

/** The Conversations home now has a Today / Mistakes / Practice header, so the list can sit below the fold. */
async function openConversation() {
  await tap("Conversations")
  await Bun.sleep(2500)
  await tap("Sync now", {timeoutMs: 20_000}).catch(() => undefined)
  await Bun.sleep(3000)
  await scrollUntil(CONVERSATION_ROW, 10, 15_000)
  await tap(CONVERSATION_ROW)
  await Bun.sleep(3000)
}

async function openSettings() {
  await tap("Settings")
  await Bun.sleep(1500)
}

async function healthy(url: string): Promise<boolean> {
  return fetch(url, {signal: AbortSignal.timeout(3000)})
    .then((r) => r.ok)
    .catch(() => false)
}

async function main() {
  step("setup: both backends up, app on the emulator pointing at the local Metro and servers")
  // A previous run may have been interrupted while the server was deliberately down.
  if (!(await healthy(`${state.mandarinUrl}/healthz`))) {
    console.log("Mandarin server is down from an earlier run: starting it")
    await control("/mandarin/start")
  }
  check(
    "Mandarin and LinkLingo backends are healthy",
    (await healthy(`${state.mandarinUrl}/healthz`)) && (await healthy(`${state.linklingoUrl}/ping`)),
  )
  await ensureDebugHost()
  for (const port of [3711, 3712, 8082])
    await Bun.spawn(["adb", "-s", SERIAL, "reverse", `tcp:${port}`, `tcp:${port}`]).exited
  await forceStop()
  await launch()
  await Bun.sleep(4000)

  step("Settings: AnkiDroid ready, learning on, phone credential saved")
  await openSettings()
  await scrollUntil("Learn from my conversations")
  const toggle = (await dump()).find((n) => n.desc === "Learn from my conversations" && n.cls.endsWith("Switch"))!
  if (!toggle.checked) {
    await tapAt(toggle.cx, toggle.cy)
    await Bun.sleep(1500)
  }
  const ankiReady = (await dump()).map(label).filter((l) => l === "Ready").length
  check(
    "AnkiDroid reports installed, up to date, access granted, collection ready",
    ankiReady >= 4,
    `${ankiReady} Ready rows`,
  )
  await scrollUntil("Save credential")
  const field = (await dump()).find((n) => n.cls.endsWith("EditText") && /credential/i.test(label(n)))!
  await tapAt(field.cx, field.cy)
  await Bun.sleep(500)
  await typeText(state.ownerCredential)
  await back()
  await Bun.sleep(500)
  await tap("Save credential")
  await Bun.sleep(2500)
  check("credential accepted", Boolean(await find(/saved on this phone/i)))
  // The accessibility tree on a busy emulator can stop following the screen after typing; a fresh app start is the reliable reset.
  await forceStop()
  await launch()
  await Bun.sleep(3500)
  await openSettings()

  step("pairing: the code shown on the phone is redeemed through LinkLingo's real backend")
  // Create the code in the app. The code is read from the response the phone received (see scripts/device/up.ts):
  // uiautomator cannot see a screen that ticks every second on a loaded machine. Whether the screen also shows it is
  // checked on a best-effort basis below.
  const before = (await lastPairing())?.secret ?? null
  let code: string | undefined
  for (let attempt = 0; attempt < 4 && !code; attempt++) {
    await scrollUntil(/Create (a new|pairing) code/).catch(() => undefined)
    await tap(/Create (a new|pairing) code/).catch(() => undefined)
    for (let i = 0; i < 15 && !code; i++) {
      await Bun.sleep(1000)
      const latest = (await lastPairing())?.secret
      if (latest && latest !== before) code = latest
    }
  }
  check("the app created a pairing code", Boolean(code))
  const onScreen = await waitFor(/^mps_/, 8_000)
    .then(() => true)
    .catch(() => false)
  console.log(
    `   (the code is also visible in the accessibility tree: ${onScreen}; on an overloaded machine uiautomator may not see a ticking screen)`,
  )
  const paired = await fetch(`${state.linklingoUrl}/api/learning/pair`, {
    method: "POST",
    headers: {"authorization": `Bearer ${await mint()}`, "content-type": "application/json"},
    body: JSON.stringify({secret: code}),
  })
  check("LinkLingo redeemed it under Mentra authentication", paired.status === 200, `HTTP ${paired.status}`)
  const reuse = await fetch(`${state.linklingoUrl}/api/learning/pair`, {
    method: "POST",
    headers: {"authorization": `Bearer ${await mint("someone-else")}`, "content-type": "application/json"},
    body: JSON.stringify({secret: code}),
  })
  check("the same code cannot be used twice", reuse.status === 400)
  // The code card re-renders every second and keeps uiautomator from seeing the screen on a loaded machine, so leave it:
  // a fresh app start shows the connection list without the countdown.
  await forceStop()
  await launch()
  await Bun.sleep(3500)
  await openSettings()
  await scrollUntil("Connections")
  check("the connection appears in the app", Boolean(await waitFor(/Active/, 30_000).catch(() => null)))

  step("conversation: events delivered through the real backend appear once in the app")
  await sendEvents(["你好，你昨天做什么了？", S1, "样品怎么样？"], 0, SESSION)
  await Bun.sleep(3000)
  await back()
  await Bun.sleep(800)
  await tap("Conversations")
  await Bun.sleep(3000)
  // The app pulls changes at startup, on foreground and once a minute; "Sync now" is the learner's own button for it.
  await tap("Sync now", {timeoutMs: 20_000}).catch(() => undefined)
  await Bun.sleep(4000)
  const convoNode = await scrollUntil(CONVERSATION_ROW, 10, 25_000)
  check("conversation listed with 3 lines", /3 lines/.test(label(convoNode)) || Boolean(await find("3 lines")))
  await tap(CONVERSATION_ROW)
  await Bun.sleep(3000)
  check("original wording is shown", Boolean(await scrollUntil(S1, 6, 15_000).catch(() => null)))

  step("decisions: speaker is separate from the correction, and Someone else is never counted")
  // The learner marks line 1 as someone else and line 2 as theirs, with the app's own buttons.
  await tapFirst("Someone else")
  await scrollToClickable("Mine")
  await tapFirst("Mine")
  const convs = (await api("GET", "/conversations")).body.conversations
  const convId = convs[0].id
  const detail = (await api("GET", `/conversations/${convId}`)).body
  const seg = detail.segments.find((s: any) => s.originalText === S1)
  const first = detail.segments.find((s: any) => s.originalText.startsWith("你好"))
  check(
    "line 1 is recorded as someone else and line 2 as mine, on the server",
    first.attribution === "other" && seg.attribution === "mine",
    `${first.attribution}/${seg.attribution}`,
  )
  check(
    "the unreviewed third line is still unknown (never inferred)",
    detail.segments.find((s: any) => s.originalText === "样品怎么样？").attribution === "unknown",
  )
  const finding = (
    await api("POST", "/findings", {
      mutationId: `mut-stage1-find-${Date.now()}`,
      conversationId: convId,
      segmentIds: [seg.id],
      excerpt: S1_EXCERPT,
      correction: S1_FIX,
      intendedEnglish: S1_EN,
      explanation: "Keep the purpose phrase with the action; here 了 follows 看.",
    })
  ).body
  check(
    "a finding must quote its source exactly (an invented excerpt is refused)",
    (
      await api("POST", "/findings", {
        mutationId: `mut-stage1-bad-${Date.now()}`,
        conversationId: convId,
        segmentIds: [seg.id],
        excerpt: "这句话不存在",
        correction: "别的",
      })
    ).status === 400,
  )
  await forceStop()
  await launch()
  await Bun.sleep(3500)
  await openConversation()
  await scrollUntil(new RegExp(`${S1_EXCERPT}\\s+→\\s+${S1_FIX}`))
  await tap(new RegExp(`${S1_EXCERPT}\\s+→\\s+${S1_FIX}`))
  await Bun.sleep(3000)
  check("before any decision the finding is not counted", Boolean(await find("Not counted")))
  await tapLast("Mine")
  await Bun.sleep(1500)
  check("speaker alone does not count it", Boolean(await find(/Not counted until you accept the correction/)))
  await tapLast("Accept")
  await Bun.sleep(2500)
  check("Mine + Accept counts as one of my mistakes", Boolean(await find("Counted as one of your mistakes.")))
  const serverFinding = (await api("GET", `/conversations/${convId}`)).body.findings.find(
    (f: any) => f.id === finding.id,
  )
  check(
    "the server holds both decisions",
    serverFinding.attribution === "mine" && serverFinding.decision === "confirmed",
  )

  step("card: the draft is persisted before the preview, English front and Chinese back")
  await scrollUntil("Create card")
  await tap("Create card")
  await Bun.sleep(5000)
  const drafts = (await api("GET", "/card-drafts")).body.drafts
  const draft = drafts.find((d: any) => d.findingId === finding.id)
  check("a persistent draft exists with a stable sentence id", Boolean(draft?.sentenceId))
  check(
    "front is the English meaning, back is the corrected Chinese",
    Boolean(await find(S1_EN)) && Boolean(await find(S1_FIX)),
  )
  check("the source passage is not on the card", !(await dump()).some((n) => label(n).includes(S1)))

  step("save: a triple tap and a missing voice server still produce exactly one note")
  await scrollUntil("Save selected cards")
  const save = (await find("Save selected cards"))!
  await shell(`input tap ${save.cx} ${save.cy}; input tap ${save.cx} ${save.cy}; input tap ${save.cx} ${save.cy}`)
  await Bun.sleep(6000)
  const noAudio = await find("Save without audio")
  if (noAudio) {
    await shell(`input tap ${noAudio.cx} ${noAudio.cy}; input tap ${noAudio.cx} ${noAudio.cy}`)
    await Bun.sleep(8000)
  }
  check("the app says saved in AnkiDroid", Boolean(await find("Saved in AnkiDroid")))
  let notes = await ankiNotesFor(draft.sentenceId)
  check(
    "AnkiDroid's own collection has exactly one note for the sentence id",
    notes.length === 1,
    `${notes.length} notes`,
  )
  check(
    "it is in the Grammar deck with the grammar card only",
    /ord 0 deck Mandarin.*Grammar/.test(notes[0]?.cards ?? "") && !/ord 1/.test(notes[0]?.cards ?? ""),
    notes[0]?.cards,
  )
  check(
    "fields hold the Chinese answer, English prompt and the sentence id",
    [S1_FIX, S1_EN, draft.sentenceId].every((t) => notes[0]?.fields.includes(t)),
  )
  let exportsRows: any[] = []
  for (let i = 0; i < 15 && exportsRows.length === 0; i++) {
    await Bun.sleep(1500)
    exportsRows = await sql(`SELECT state, note_id::text AS note_id FROM anki_exports WHERE draft_id = '${draft.id}'`)
  }
  check(
    "one verified receipt reached Mandarin, with the same note id",
    exportsRows.length === 1 && exportsRows[0].note_id === notes[0]?.id,
    JSON.stringify(exportsRows),
  )
  console.log("   screenshot:", await screenshot("stage1-saved"))

  step("interruption: server down while saving, app killed right after, then everything reconnects")
  await tap("Done").catch(() => {})
  await Bun.sleep(1000)
  await sendEvents([S2], 3, SESSION)
  await Bun.sleep(3000)
  const detail2 = (await api("GET", `/conversations/${convId}`)).body
  const seg2 = detail2.segments.find((s: any) => s.originalText === S2)
  const finding2 = (
    await api("POST", "/findings", {
      mutationId: `mut-stage1-find2-${Date.now()}`,
      conversationId: convId,
      segmentIds: [seg2.id],
      excerpt: S2_EXCERPT,
      correction: S2_FIX,
      intendedEnglish: S2_EN,
      explanation: "Use 到 for the destination of a ticket.",
    })
  ).body
  await api("PATCH", `/findings/${finding2.id}`, {
    mutationId: `mut-stage1-acc2-${Date.now()}`,
    expectedRevision: 1,
    attribution: "mine",
    decision: "confirmed",
  })
  const draft2 = (
    await api("POST", "/card-drafts", {mutationId: `mut-stage1-draft2-${Date.now()}`, findingId: finding2.id})
  ).body
  await forceStop()
  await launch()
  await Bun.sleep(3500)
  await tap("Flashcards")
  await Bun.sleep(3000)
  const inbox = await waitFor(new RegExp(`Shenzhen ${TAG}`), 30_000).catch(() => undefined)
  check("the draft inbox lists the persisted draft", Boolean(inbox))
  if (inbox) {
    // "Review and save" is the button under that draft's text.
    const nodes = await dump()
    const button = nodes
      .filter((n) => label(n) === "Review and save" && n.clickable && n.cy > inbox.cy)
      .sort((a, b) => a.cy - b.cy)[0]
    if (!button) throw new Error("no Review and save button under the Shenzhen draft")
    await tapAt(button.cx, button.cy)
    await Bun.sleep(4000)
  }
  await control("/mandarin/kill")
  await scrollUntil("Save selected cards")
  const save2 = (await find("Save selected cards"))!
  await tapAt(save2.cx, save2.cy)
  await Bun.sleep(6000)
  const noAudio2 = await find("Save without audio")
  if (noAudio2) {
    await tapAt(noAudio2.cx, noAudio2.cy)
    await Bun.sleep(8000)
  }
  check("saved on the phone while the server was down", Boolean(await find("Saved in AnkiDroid")))
  await forceStop()
  notes = await ankiNotesFor(draft2.sentenceId)
  check("exactly one note exists after the app was killed", notes.length === 1, `${notes.length} notes`)
  check(
    "the server has no receipt yet (it was down)",
    (await sql(`SELECT 1 FROM anki_exports WHERE draft_id = '${draft2.id}'`)).length === 0,
  )
  await launch()
  await Bun.sleep(8000)
  notes = await ankiNotesFor(draft2.sentenceId)
  check("relaunching offline does not create a second note", notes.length === 1, `${notes.length} notes`)
  await control("/mandarin/start")
  await shell("input keyevent KEYCODE_HOME")
  await Bun.sleep(1500)
  await launch()
  let late: any[] = []
  for (let i = 0; i < 25 && late.length === 0; i++) {
    await Bun.sleep(2000)
    late = await sql(`SELECT state, note_id::text AS note_id FROM anki_exports WHERE draft_id = '${draft2.id}'`)
  }
  check(
    "the queued receipt reached Mandarin after reconnecting",
    late.length === 1 && late[0].state === "verified" && late[0].note_id === notes[0]?.id,
    JSON.stringify(late),
  )
  notes = await ankiNotesFor(draft2.sentenceId)
  check(
    "still exactly one note, in the right deck",
    notes.length === 1 && /Grammar/.test(notes[0]?.cards ?? ""),
    notes[0]?.cards,
  )
  check(
    "the draft is Saved locally, linked to its finding and source segment",
    JSON.stringify(
      (
        await sql(
          `SELECT status, finding_id = '${finding2.id}' AS linked, '${seg2.id}' = ANY(segment_ids) AS source FROM card_drafts WHERE id = '${draft2.id}'`,
        )
      )[0],
    ) === JSON.stringify({status: "saved_locally", linked: true, source: true}),
  )
}

try {
  await main()
} catch (error) {
  // Never leave the server down for the next run.
  if (!(await healthy(`${state.mandarinUrl}/healthz`))) await control("/mandarin/start").catch(() => {})
  failures++
  console.error("\nFAILED with an exception:", error)
  console.log("screenshot:", await screenshot("stage1-failure"))
}
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
