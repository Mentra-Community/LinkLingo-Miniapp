import {describe, expect, test} from "bun:test"

import type {MiniappSession} from "@mentra/miniapp/background"
import {bareWord, TranslationCache} from "./translationCache"

function fakeSession(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    storage: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value)
      },
    },
    _store: store,
  } as unknown as MiniappSession & {_store: Map<string, string>}
}

describe("TranslationCache", () => {
  test("serves a word it has already seen, keeping the backend's annotation", async () => {
    const cache = new TranslationCache(fakeSession())
    await cache.load()
    cache.remember([{word: "博物馆 (bó wù guǎn)", translation: "museum", at: 1}], "zh", "en")

    const hit = cache.get("博物馆", "zh", "en")
    expect(hit?.word).toBe("博物馆 (bó wù guǎn)")
    expect(hit?.translation).toBe("museum")
  })

  test("the same spelling in the other direction is a different entry", async () => {
    const cache = new TranslationCache(fakeSession())
    await cache.load()
    cache.remember([{word: "museum", translation: "博物馆", at: 1}], "en", "zh")

    expect(cache.get("museum", "en", "zh")).not.toBeNull()
    expect(cache.get("museum", "zh", "en")).toBeNull()
  })

  test("survives a restart", async () => {
    const session = fakeSession()
    const first = new TranslationCache(session)
    await first.load()
    first.remember([{word: "油腻", translation: "greasy", at: 1}], "zh", "en")
    await first.flush()

    const second = new TranslationCache(session)
    await second.load()
    expect(second.get("油腻", "zh", "en")?.translation).toBe("greasy")
  })

  test("a corrupt store starts empty instead of failing startup", async () => {
    const cache = new TranslationCache(fakeSession({"linklingo:translations": "{not json"}))
    await cache.load()
    expect(cache.size).toBe(0)
  })

  test("evicts the least recently written once full", async () => {
    const cache = new TranslationCache(fakeSession())
    await cache.load()
    for (let i = 0; i < 1600; i++) {
      cache.remember([{word: `w${i}`, translation: `t${i}`, at: i}], "zh", "en")
    }
    expect(cache.size).toBe(1500)
    expect(cache.get("w0", "zh", "en")).toBeNull()
    expect(cache.get("w1599", "zh", "en")).not.toBeNull()
  })

  test("re-glossing a word keeps it from being evicted", async () => {
    const cache = new TranslationCache(fakeSession())
    await cache.load()
    cache.remember([{word: "keepme", translation: "t", at: 0}], "zh", "en")
    for (let i = 0; i < 1499; i++) {
      cache.remember([{word: `w${i}`, translation: `t${i}`, at: i}], "zh", "en")
    }
    // Touch it again, then overflow by one.
    cache.remember([{word: "keepme", translation: "t", at: 1}], "zh", "en")
    cache.remember([{word: "overflow", translation: "t", at: 2}], "zh", "en")

    expect(cache.get("keepme", "zh", "en")).not.toBeNull()
  })
})

describe("bareWord", () => {
  test("drops the pinyin annotation so the key is the word itself", () => {
    expect(bareWord("博物馆 (bó wù guǎn)")).toBe("博物馆")
    expect(bareWord("museum")).toBe("museum")
  })
})
