import {beforeEach, describe, expect, test} from "bun:test"

import type {SourceIdentity} from "../vendor/mandarin-contract"
import {LearningService, transcriptUserFor, type LearningConfig} from "./learning-outbox"
import {learnerVocabulary} from "./learner-vocabulary"
import {ObjectTape, type ObjectListOptions, type ObjectStore} from "./tape-store"
import type {TranscriptEntry} from "./transcript-log"
import type {VocabularyBatch} from "./vocabulary-contract"
import {
  VocabularyScanner,
  chinaDayBounds,
  previousCompleteChinaDate,
  type VocabularyDeliveryResult,
} from "./vocabulary-scan"

class MapStore implements ObjectStore {
  readonly objects = new Map<string, string>()

  async put(key: string, body: string): Promise<void> {
    this.objects.set(key, body)
  }

  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null
  }

  async list(prefix: string, options: ObjectListOptions = {}): Promise<string[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .filter((key) => !options.startAfter || key > options.startAfter)
      .filter((key) => !options.before || key < options.before)
      .sort()
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key)
  }
}

function transcript(id: string, user: string, at: number, text: string): TranscriptEntry {
  return {
    id,
    user,
    at,
    text,
    inputLanguage: "zh",
    outputLanguage: "en",
    proficiency: 50,
    knownRank: 3000,
    mode: "gloss",
    disposition: "skipped_no_candidates",
    wouldGloss: [],
  }
}

async function seedDay(store: ObjectStore, date: string, entries: TranscriptEntry[]): Promise<void> {
  const tape = new ObjectTape(store)
  for (const entry of entries) await tape.put("transcript", entry)
}

beforeEach(() => learnerVocabulary.clear())

describe("China-local day boundaries", () => {
  test("selects the prior complete Asia/Shanghai day at both sides of midnight", () => {
    expect(previousCompleteChinaDate(Date.parse("2026-10-30T15:59:59Z"))).toBe("2026-10-29")
    expect(previousCompleteChinaDate(Date.parse("2026-10-30T16:00:00Z"))).toBe("2026-10-30")
    expect(chinaDayBounds("2026-10-30")).toEqual({
      from: Date.parse("2026-10-29T16:00:00Z"),
      to: Date.parse("2026-10-30T16:00:00Z"),
    })
  })
})

describe("daily vocabulary scanner", () => {
  test("scans all transcript text, derives evidence, and survives a restart without regenerating", async () => {
    const store = new MapStore()
    const date = "2026-10-30"
    const {from} = chinaDayBounds(date)
    await seedDay(store, date, [
      transcript("a", "user-a", from + 60_000, "这个方案需要斟酌。"),
      transcript("b", "user-a", from + 10 * 60_000, "我们再斟酌斟酌。"),
      transcript("c", "user-a", from + 50 * 60_000, "最后还是要斟酌。"),
    ])

    const prompts: string[] = []
    const delivered: VocabularyBatch[] = []
    const scanner = new VocabularyScanner({
      store,
      catchupDays: 1,
      now: () => Date.parse("2026-10-31T04:00:00Z"),
      enabled: () => true,
      generate: async (options) => {
        prompts.push(options.user)
        return {
          text: JSON.stringify({
            candidates: [
              {
                word: "斟酌",
                pinyin: "zhēn zhuó",
                english: "to weigh carefully",
                reasons: ["formal and reusable verb"],
                confidence: "high",
              },
              {
                word: "不存在",
                pinyin: "bù cún zài",
                english: "hallucinated",
                reasons: ["not in corpus"],
                confidence: "high",
              },
            ],
          }),
        }
      },
      delivery: {
        async deliverVocabularyBatch(_user, batch) {
          delivered.push(batch)
          return {outcome: "accepted"}
        },
      },
    })

    expect(await scanner.runDay(date)).toBe("complete")
    expect(prompts.join("\n")).toContain("这个方案需要斟酌")
    expect(prompts.join("\n")).toContain("最后还是要斟酌")
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.candidates).toHaveLength(1)
    expect(delivered[0]!.candidates[0]).toMatchObject({
      word: "斟酌",
      pinyin: "zhēn zhuó",
      totalAppearances: 4,
      distinctSessions: 2,
      confidence: "high",
    })
    expect(delivered[0]!.candidates[0]!.contexts).toHaveLength(3)

    const records = await scanner.query({date})
    expect(records).toHaveLength(1)
    expect(records[0]!.status).toBe("delivered")

    const restarted = new VocabularyScanner({
      store,
      enabled: () => true,
      generate: async () => {
        throw new Error("must not regenerate")
      },
      delivery: {
        async deliverVocabularyBatch() {
          throw new Error("must not redeliver a committed batch")
        },
      },
    })
    learnerVocabulary.clear()
    expect(await restarted.runDay(date)).toBe("complete")
    expect(learnerVocabulary.match("user-a", "还需要继续斟酌。", 3_000, [], 3)[0]?.word).toBe("斟酌")
  })

  test("retries an identical stored batch after a lost/failed delivery", async () => {
    const store = new MapStore()
    const date = "2026-10-30"
    const {from} = chinaDayBounds(date)
    await seedDay(store, date, [transcript("a", "user-a", from + 1_000, "这件事很棘手。")])

    const attempts: string[] = []
    let deliveryAttempt = 0
    const delivery = {
      async deliverVocabularyBatch(_user: string, batch: VocabularyBatch): Promise<VocabularyDeliveryResult> {
        attempts.push(JSON.stringify(batch))
        deliveryAttempt++
        return deliveryAttempt === 1 ? {outcome: "retry_later", error: "reply lost"} : {outcome: "duplicate"}
      },
    }
    const scanner = new VocabularyScanner({
      store,
      enabled: () => true,
      generate: async () => ({
        text: JSON.stringify({
          candidates: [
            {
              word: "棘手",
              pinyin: "jí shǒu",
              english: "troublesome",
              reasons: ["idiomatic adjective"],
              confidence: "high",
            },
          ],
        }),
      }),
      delivery,
    })

    await scanner.runDay(date)
    expect((await scanner.query({date}))[0]!.status).toBe("ready")
    await scanner.runDay(date)
    expect((await scanner.query({date}))[0]!.status).toBe("delivered")
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toBe(attempts[0])
  })
})

describe("paired Mandarin delivery", () => {
  test("uses the paired credential and vocabulary endpoint for the matching transcript digest", async () => {
    const store = new MapStore()
    const identity: SourceIdentity = {issuer: "cloud-core", subject: "learner-1", environment: "dev"}
    const config: LearningConfig = {
      enabled: true,
      mandarinUrl: "https://mandarin.test",
      serviceKey: "s".repeat(40),
      configKey: Buffer.alloc(32, 4),
    }
    const calls: Array<{url: string; auth: string | null; body: unknown}> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      calls.push({url, auth: new Headers(init.headers).get("authorization"), body})
      if (url.endsWith("/pairing/redeem")) {
        return Response.json(
          {
            connectionId: "connection-1",
            deliveryCredential: "mcd_" + "x".repeat(40),
            ownerLabel: "Learner",
          },
          {status: 201},
        )
      }
      return Response.json({batchId: body.batchId, candidates: body.candidates}, {status: 201})
    }) as typeof fetch
    const service = new LearningService(store, config, {fetch: fetchImpl})
    await service.pair(identity, "mps_" + "a".repeat(32))

    const batch: VocabularyBatch = {
      schemaVersion: 1,
      source: "linklingo",
      batchId: "llv_12345678",
      localDate: "2026-10-30",
      timezone: "Asia/Shanghai",
      generatedAt: "2026-10-31T00:00:00.000Z",
      transcriptStartAt: "2026-10-30T00:00:00.000Z",
      transcriptEndAt: "2026-10-30T01:00:00.000Z",
      transcriptCount: 1,
      inferredSessionCount: 2,
      candidates: [
        {
          word: "斟酌",
          pinyin: "zhēn zhuó",
          english: "to weigh carefully",
          corpusRank: 8123,
          totalAppearances: 3,
          distinctSessions: 2,
          contexts: [
            {
              text: "这个方案需要斟酌。",
              capturedAt: "2026-10-30T00:00:00.000Z",
              sessionId: "2026-10-30-s001",
            },
            {
              text: "我们再斟酌一下。",
              capturedAt: "2026-10-30T01:00:00.000Z",
              sessionId: "2026-10-30-s002",
            },
          ],
          reasons: ["formal and reusable verb"],
          confidence: "high",
        },
      ],
    }
    expect(await service.deliverVocabularyBatch(transcriptUserFor(identity), batch)).toEqual({outcome: "accepted"})
    expect(await service.deliverVocabularyBatch(transcriptUserFor(identity), batch)).toEqual({outcome: "accepted"})
    expect(calls[1]).toMatchObject({
      url: "https://mandarin.test/v1/learning/vocabulary/batches",
      auth: `Bearer ${"mcd_" + "x".repeat(40)}`,
    })
    expect(calls[1]!.body).toEqual({
      schemaVersion: 1,
      batchId: "llv_12345678",
      sourceDay: "2026-10-30",
      candidates: [
        {
          word: "斟酌",
          pinyin: "zhēn zhuó",
          meaning: "to weigh carefully",
          situation: "Link Lingo on 2026-10-30 across 2 inferred sessions.",
          count: 3,
          sessionIds: ["2026-10-30-s001", "2026-10-30-s002"],
          contexts: ["这个方案需要斟酌。", "我们再斟酌一下。"],
          rank: 8123,
          reasons: ["formal and reusable verb"],
        },
      ],
    })
    expect(calls[2]!.body).toEqual(calls[1]!.body)
  })
})
