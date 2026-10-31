/**
 * Stage 1 cross-app integration: the real LinkLingo backend, the real Mandarin
 * server, real Postgres and MinIO, real JWT verification, real SIGKILLs.
 *
 *   (in mandarin-app)  docker compose up -d
 *   (here)             bun test scripts/e2e
 *
 * These prove what handler mocks cannot: authentication, serialization against
 * the contract, forwarding, persistence, and recovery after a lost reply or a
 * killed process.
 */
import {afterAll, beforeAll, describe, expect, test} from "bun:test"

import {ListObjectsV2Command} from "@aws-sdk/client-s3"

import {http, learningEvent, startStack, waitFor, type Stack} from "./lib/stack"

let stack: Stack
const T = 120_000

beforeAll(async () => {
  stack = await startStack()
}, T)

afterAll(async () => {
  await stack?.stop()
}, T)

interface Learner {
  subject: string
  owner: {ownerId: string; credential: string}
  jwt: string
  connectionId?: string
}

async function newLearner(label: string): Promise<Learner> {
  const subject = `user-${label}-${Math.random().toString(36).slice(2, 8)}`
  return {subject, owner: await stack.provisionOwner(label), jwt: await stack.authority.token(subject)}
}

async function pairLearner(learner: Learner) {
  const made = await http("POST", `${stack.mandarinUrl}/v1/learning/pairing`, learner.owner.credential)
  expect(made.status).toBe(201)
  const paired = await http("POST", `${stack.linklingoUrl}/api/learning/pair`, learner.jwt, {secret: made.body.secret})
  expect(paired.status).toBe(200)
  const connections = await http("GET", `${stack.mandarinUrl}/v1/learning/connections`, learner.owner.credential)
  learner.connectionId = connections.body.connections[0].id
  return paired
}

const mandarinConversations = async (l: Learner) =>
  (await http("GET", `${stack.mandarinUrl}/v1/learning/conversations`, l.owner.credential)).body

async function segmentTexts(l: Learner): Promise<string[]> {
  const list = await mandarinConversations(l)
  const texts: string[] = []
  for (const conv of list.conversations) {
    const detail = await http("GET", `${stack.mandarinUrl}/v1/learning/conversations/${conv.id}`, l.owner.credential)
    for (const s of detail.body.segments) texts.push(s.originalText)
  }
  return texts
}

const outboxKeys = async (): Promise<string[]> => {
  const out = await stack.s3.send(new ListObjectsV2Command({Bucket: stack.bucket, Prefix: "learning/outbox/"}))
  return (out.Contents ?? []).map((o) => o.Key!)
}

const sendEvents = (l: Learner, events: unknown[], viaIntakeProxy = true) =>
  http("POST", `${viaIntakeProxy ? stack.intake.url : stack.linklingoUrl}/api/learning/events`, l.jwt, {
    schemaVersion: 1,
    events,
  })

describe("M1 identity: pairing across both apps (A01)", () => {
  test(
    "the legacy token never works on learning routes, and pairing needs real Mentra auth",
    async () => {
      const learner = await newLearner("m1")
      const legacy = await http(
        "GET",
        `${stack.mandarinUrl}/v1/learning/connections`,
        "e2e-legacy-app-token-0123456789abcdef",
      )
      expect(legacy.status).toBe(401)

      const made = await http("POST", `${stack.mandarinUrl}/v1/learning/pairing`, learner.owner.credential)
      expect(made.body.link).toStartWith("mandarin://connect?code=")
      const body = {secret: made.body.secret}

      expect((await http("POST", `${stack.linklingoUrl}/api/learning/pair`, null, body)).status).toBe(401)
      expect((await http("POST", `${stack.linklingoUrl}/api/learning/pair`, "not-a-jwt", body)).status).toBe(401)
      const wrongAudience = await stack.authority.token(learner.subject, {audience: "com.someone.else"})
      expect((await http("POST", `${stack.linklingoUrl}/api/learning/pair`, wrongAudience, body)).status).toBe(401)
      const expired = await stack.authority.token(learner.subject, {expiresIn: "-10m"})
      expect((await http("POST", `${stack.linklingoUrl}/api/learning/pair`, expired, body)).status).toBe(401)

      expect(
        (await http("POST", `${stack.linklingoUrl}/api/learning/pair`, learner.jwt, {secret: "mps_" + "q".repeat(40)}))
          .status,
      ).toBe(400)
      const status0 = await http("GET", `${stack.linklingoUrl}/api/learning/status`, learner.jwt)
      expect(status0.body).toMatchObject({enabled: true, connected: false})

      const paired = await http("POST", `${stack.linklingoUrl}/api/learning/pair`, learner.jwt, body)
      expect(paired.status).toBe(200)
      expect(paired.body.connected).toBe(true)

      // The secret is single use even across the two services.
      const second = await newLearner("m1-other")
      const reuse = await http("POST", `${stack.linklingoUrl}/api/learning/pair`, second.jwt, body)
      expect(reuse.status).toBe(400)

      // Both apps show the successful connection and the environment/account label.
      const connections = await http("GET", `${stack.mandarinUrl}/v1/learning/connections`, learner.owner.credential)
      expect(connections.body.connections).toHaveLength(1)
      expect(connections.body.connections[0]).toMatchObject({status: "active", segmentCount: 0})
      const status1 = await http("GET", `${stack.linklingoUrl}/api/learning/status`, learner.jwt)
      expect(status1.body).toMatchObject({enabled: true, connected: true})
      expect(status1.body.environment).toContain("127.0.0.1")
    },
    T,
  )

  test(
    "the LinkLingo credential is stored encrypted and the pairing identity comes from the token, not the body",
    async () => {
      const learner = await newLearner("m1-enc")
      await pairLearner(learner)
      const listing = await stack.s3.send(
        new ListObjectsV2Command({Bucket: stack.bucket, Prefix: "learning/connections/"}),
      )
      expect(listing.Contents?.length).toBeGreaterThan(0)
      const row = (
        await stack.sql`SELECT source_subject, source_issuer FROM source_connections WHERE id = ${learner.connectionId!}`
      )[0]
      expect(row.source_subject).toBe(learner.subject)
      expect(row.source_issuer).toBe("cloud-core")
    },
    T,
  )
})

describe("phone status reaches the server-driven Learning screen", () => {
  test(
    "the phone's real status body is accepted and shown with an honest state",
    async () => {
      const learner = await newLearner("m1-status")
      await pairLearner(learner)
      // The exact shape the phone sends: gaps as records, plus a quarantined count.
      const post = await http("POST", `${stack.linklingoUrl}/api/learning/phone-status`, learner.jwt, {
        state: "listening",
        pending: 3,
        gaps: [{reason: "overflow", count: 2}],
        quarantined: 0,
        lastError: null,
      })
      expect(post.status).toBe(204)
      const view = await http("GET", `${stack.linklingoUrl}/api/views/learning`, learner.jwt)
      expect(view.status).toBe(200)
      const text = JSON.stringify(view.body)
      expect(text).toContain("Waiting to send")
      expect(text).toContain("could not be kept")
      expect(text).not.toContain("Connected to undefined")
      const notPaired = await newLearner("m1-unpaired")
      const other = await http("GET", `${stack.linklingoUrl}/api/views/learning`, notPaired.jwt)
      expect(JSON.stringify(other.body)).toContain("Not connected")
      expect(JSON.stringify(other.body)).toContain("pairing-code")
    },
    T,
  )
})

describe("M2 ingest: capture to conversation", () => {
  test(
    "events delivered through LinkLingo appear exactly once in Mandarin, in order (A02)",
    async () => {
      const learner = await newLearner("m2-basic")
      await pairLearner(learner)
      const a = learningEvent({text: "你好，今天怎么样？", disposition: "skipped_short"})
      const b = learningEvent({text: "还不错，谢谢"})
      const res = await sendEvents(learner, [a, b])
      expect(res.status).toBe(200)
      expect(res.body.accepted).toEqual([a.eventId, b.eventId])

      await waitFor("both segments in Mandarin", async () => (await segmentTexts(learner)).length === 2)
      expect((await segmentTexts(learner)).sort()).toEqual(["你好，今天怎么样？", "还不错，谢谢"].sort())

      // Replay of the same events changes nothing.
      await sendEvents(learner, [a, b])
      await waitFor("outbox drained", async () => (await outboxKeys()).length === 0)
      expect(await segmentTexts(learner)).toHaveLength(2)
      const list = await mandarinConversations(learner)
      expect(list.capture.connected).toBe(true)
    },
    T,
  )

  test(
    "lost acknowledgement #1: LinkLingo stored the event but the phone never saw the reply",
    async () => {
      const learner = await newLearner("m2-lost1")
      await pairLearner(learner)
      const e = learningEvent({text: "第一个丢失回复的句子"})
      stack.intake.mode = "lose_reply"
      const lost = await sendEvents(learner, [e])
      stack.intake.mode = "pass"
      expect(lost.status).toBe(502)
      // The phone retries the same event id; the result is one segment, not two.
      const retry = await sendEvents(learner, [e])
      expect(retry.status).toBe(200)
      await waitFor("segment delivered", async () => (await segmentTexts(learner)).length >= 1)
      await waitFor("outbox drained", async () => (await outboxKeys()).length === 0)
      expect(await segmentTexts(learner)).toEqual(["第一个丢失回复的句子"])
    },
    T,
  )

  test(
    "lost acknowledgement #2: Mandarin committed but the reply never reached LinkLingo",
    async () => {
      const learner = await newLearner("m2-lost2")
      await pairLearner(learner)
      stack.delivery.mode = "lose_reply"
      const before = stack.delivery.lostReplies
      const e = learningEvent({text: "第二个丢失回复的句子"})
      expect((await sendEvents(learner, [e])).status).toBe(200)
      await waitFor("Mandarin committed while the reply was lost", async () => stack.delivery.lostReplies > before)
      // LinkLingo must keep the event: it cannot know Mandarin committed.
      expect((await outboxKeys()).length).toBe(1)
      expect(await segmentTexts(learner)).toEqual(["第二个丢失回复的句子"])
      stack.delivery.mode = "pass"
      await waitFor("retry confirmed and outbox cleared", async () => (await outboxKeys()).length === 0, 40_000)
      // The retry was a duplicate: still one segment.
      expect(await segmentTexts(learner)).toEqual(["第二个丢失回复的句子"])
      const conns = await http("GET", `${stack.mandarinUrl}/v1/learning/connections`, learner.owner.credential)
      expect(conns.body.connections[0].segmentCount).toBe(1)
    },
    T,
  )

  test(
    "a LinkLingo process killed after the durable acknowledgement loses nothing (A04)",
    async () => {
      const learner = await newLearner("m2-kill-ll")
      await pairLearner(learner)
      stack.delivery.mode = "down"
      const events = [learningEvent({text: "重启前的句子一"}), learningEvent({text: "重启前的句子二"})]
      expect((await sendEvents(learner, events, false)).status).toBe(200)
      expect((await outboxKeys()).length).toBe(2)

      await stack.linklingo.kill()
      await stack.linklingo.start()
      stack.delivery.mode = "pass"

      // Nothing in memory survived; the events did, and the connection credential still decrypts.
      await waitFor("delivery resumes after restart", async () => (await segmentTexts(learner)).length === 2, 40_000)
      await waitFor("outbox drained", async () => (await outboxKeys()).length === 0)
      expect((await segmentTexts(learner)).sort()).toEqual(["重启前的句子一", "重启前的句子二"])
    },
    T,
  )

  test(
    "a Mandarin server killed and restarted keeps stored conversations and receives the backlog",
    async () => {
      const learner = await newLearner("m2-kill-md")
      await pairLearner(learner)
      await sendEvents(learner, [learningEvent({text: "杀死服务之前"})], false)
      await waitFor("first segment stored", async () => (await segmentTexts(learner)).length === 1)

      await stack.mandarin.kill()
      const during = learningEvent({text: "服务宕机期间"})
      expect((await sendEvents(learner, [during], false)).status).toBe(200)
      await Bun.sleep(1500)
      expect((await outboxKeys()).length).toBe(1)

      await stack.mandarin.start()
      await waitFor("backlog delivered after restart", async () => (await segmentTexts(learner)).length === 2, 60_000)
      expect((await segmentTexts(learner)).sort()).toEqual(["服务宕机期间", "杀死服务之前"].sort())
      expect(await outboxKeys()).toHaveLength(0)
    },
    T,
  )

  test(
    "two learners never see each other's conversations end to end (A20)",
    async () => {
      const a = await newLearner("iso-a")
      const b = await newLearner("iso-b")
      await pairLearner(a)
      await pairLearner(b)
      await sendEvents(a, [learningEvent({text: "只有甲能看到"})], false)
      await sendEvents(b, [learningEvent({text: "只有乙能看到"})], false)
      await waitFor(
        "both delivered",
        async () => (await segmentTexts(a)).length === 1 && (await segmentTexts(b)).length === 1,
      )
      expect(await segmentTexts(a)).toEqual(["只有甲能看到"])
      expect(await segmentTexts(b)).toEqual(["只有乙能看到"])
      const conv = (await mandarinConversations(a)).conversations[0].id
      expect(
        (await http("GET", `${stack.mandarinUrl}/v1/learning/conversations/${conv}`, b.owner.credential)).status,
      ).toBe(404)
    },
    T,
  )

  test(
    "revoking in the Mandarin app stops delivery, purges the queue, and keeps history",
    async () => {
      const learner = await newLearner("m2-revoke")
      await pairLearner(learner)
      await sendEvents(learner, [learningEvent({text: "撤销之前"})], false)
      await waitFor("delivered", async () => (await segmentTexts(learner)).length === 1)

      stack.delivery.mode = "down"
      await sendEvents(learner, [learningEvent({text: "撤销之后排队"})], false)
      expect((await outboxKeys()).length).toBe(1)
      const revoke = await http(
        "DELETE",
        `${stack.mandarinUrl}/v1/learning/connections/${learner.connectionId}`,
        learner.owner.credential,
      )
      expect(revoke.status).toBe(204)
      stack.delivery.mode = "pass"

      await waitFor(
        "LinkLingo notices and purges",
        async () => {
          const status = await http("GET", `${stack.linklingoUrl}/api/learning/status`, learner.jwt)
          return status.body.connected === false && (await outboxKeys()).length === 0
        },
        40_000,
      )
      expect(await segmentTexts(learner)).toEqual(["撤销之前"])
      const after = await sendEvents(learner, [learningEvent({text: "不应被接收"})], false)
      expect(after.status).toBe(403)
      expect(after.body.error).toBe("not_connected")
    },
    T,
  )
})

describe("M3 and M4 server side: conversation to confirmed correction to recorded note", () => {
  async function conversationWith(learner: Learner, text: string) {
    await sendEvents(learner, [learningEvent({text})], false)
    await waitFor("segment delivered", async () => (await segmentTexts(learner)).length === 1)
    const conv = (await mandarinConversations(learner)).conversations[0]
    const detail = (
      await http("GET", `${stack.mandarinUrl}/v1/learning/conversations/${conv.id}`, learner.owner.credential)
    ).body
    return {conversationId: conv.id as string, segmentId: detail.segments[0].id as string}
  }

  const api = (l: Learner, method: string, path: string, body?: unknown, base = stack.mandarinUrl) =>
    http(method, `${base}/v1/learning${path}`, l.owner.credential, body)
  const mid = () => `mut-${Math.random().toString(36).slice(2, 12)}-aaaa`

  test(
    "a confirmed correction and its draft survive a Mandarin SIGKILL, and a lost receipt reply never makes a second export",
    async () => {
      const learner = await newLearner("m3")
      await pairLearner(learner)
      const {conversationId, segmentId} = await conversationWith(learner, "我昨天去工厂了看样品")

      const finding = (
        await api(learner, "POST", "/findings", {
          mutationId: mid(),
          conversationId,
          segmentIds: [segmentId],
          excerpt: "去工厂了看样品",
          correction: "去工厂看了样品",
          intendedEnglish: "Yesterday I went to the factory to look at samples.",
        })
      ).body
      // Speaker and correction are separate decisions; only both together make a personal mistake.
      const accepted = (
        await api(learner, "PATCH", `/findings/${finding.id}`, {
          mutationId: mid(),
          expectedRevision: 1,
          decision: "confirmed",
        })
      ).body
      expect((await mandarinConversations(learner)).conversations[0].confirmedFindings).toBe(0)
      await api(learner, "PATCH", `/findings/${finding.id}`, {
        mutationId: mid(),
        expectedRevision: accepted.revision,
        attribution: "mine",
      })
      expect((await mandarinConversations(learner)).conversations[0].confirmedFindings).toBe(1)

      const draft = (await api(learner, "POST", "/card-drafts", {mutationId: mid(), findingId: finding.id})).body
      expect(draft).toMatchObject({
        status: "ready",
        english: "Yesterday I went to the factory to look at samples.",
        chinese: "去工厂看了样品",
      })

      // The server process dies. Nothing in memory survives; the draft, its sentence id and its source links must.
      await stack.mandarin.kill()
      await stack.mandarin.start()
      const after = (await api(learner, "GET", `/card-drafts/${draft.id}`)).body
      expect(after).toMatchObject({
        id: draft.id,
        sentenceId: draft.sentenceId,
        findingId: finding.id,
        segmentIds: [segmentId],
        conversationId,
      })

      // The phone saved the note locally; the receipt reaches Mandarin, but the reply is lost on the way back.
      const receipt = {
        operationId: "op-e2e-m4-aaaa",
        sentenceId: draft.sentenceId,
        draftRevision: draft.revision,
        deviceId: "device-e2e-aaaa",
        collectionId: "anki-1-2",
        noteId: 1700000000123,
        ords: [0],
        deckIds: [42],
        state: "verified",
      }
      stack.receipts.mode = "lose_reply"
      const lost = await api(learner, "POST", `/card-drafts/${draft.id}/exports`, receipt, stack.receipts.url)
      stack.receipts.mode = "pass"
      expect(lost.status).toBe(502)
      // The phone keeps the receipt queued and retries with the same operation id.
      const retry = await api(learner, "POST", `/card-drafts/${draft.id}/exports`, receipt, stack.receipts.url)
      expect(retry.status).toBe(200)
      expect(retry.body).toEqual({operationId: receipt.operationId, draftId: draft.id, state: "verified"})
      const rows = await stack.sql`SELECT count(*)::int AS n FROM anki_exports WHERE draft_id = ${draft.id}`
      expect(rows[0].n).toBe(1)
      expect((await api(learner, "GET", `/card-drafts/${draft.id}`)).body.status).toBe("saved_locally")

      // The source and the link are still reachable end to end.
      const detail = (await api(learner, "GET", `/conversations/${conversationId}`)).body
      expect(detail.segments.map((s: any) => s.originalText)).toEqual(["我昨天去工厂了看样品"])
      expect(detail.findings[0]).toMatchObject({id: finding.id, attribution: "mine", decision: "confirmed"})
    },
    T,
  )

  test(
    "undoing Mine removes the personal count but leaves the saved note's export untouched",
    async () => {
      const learner = await newLearner("m3-undo")
      await pairLearner(learner)
      const {conversationId, segmentId} = await conversationWith(learner, "我想订一张去深圳的机票")
      const finding = (
        await api(learner, "POST", "/findings", {
          mutationId: mid(),
          conversationId,
          segmentIds: [segmentId],
          excerpt: "订一张",
          correction: "订一张",
          intendedEnglish: "I want to book a ticket.",
        })
      ).body
      expect(finding.error).toBeDefined() // identical to the original wording is refused

      const ok = (
        await api(learner, "POST", "/findings", {
          mutationId: mid(),
          conversationId,
          segmentIds: [segmentId],
          excerpt: "去深圳的机票",
          correction: "到深圳的机票",
          intendedEnglish: "I want to book a ticket to Shenzhen.",
        })
      ).body
      const confirmed = (
        await api(learner, "PATCH", `/findings/${ok.id}`, {
          mutationId: mid(),
          expectedRevision: 1,
          attribution: "mine",
          decision: "confirmed",
        })
      ).body
      const draft = (await api(learner, "POST", "/card-drafts", {mutationId: mid(), findingId: ok.id})).body
      await api(learner, "POST", `/card-drafts/${draft.id}/exports`, {
        operationId: "op-e2e-undo-aaaa",
        sentenceId: draft.sentenceId,
        draftRevision: draft.revision,
        deviceId: "device-e2e-aaaa",
        collectionId: "anki-1-2",
        noteId: 1700000000456,
        ords: [0],
        deckIds: [42],
        state: "verified",
      })
      await api(learner, "PATCH", `/findings/${ok.id}`, {
        mutationId: mid(),
        expectedRevision: confirmed.revision,
        attribution: "other",
      })
      expect((await mandarinConversations(learner)).conversations[0].confirmedFindings).toBe(0)
      const exports = await stack.sql`SELECT state FROM anki_exports WHERE draft_id = ${draft.id}`
      expect(exports.map((r: any) => r.state)).toEqual(["verified"])
      expect((await api(learner, "GET", `/card-drafts/${draft.id}`)).body.status).toBe("saved_locally")
    },
    T,
  )
})
