import {describe, expect, test} from "bun:test"

import {toLocale} from "./locales"

describe("toLocale", () => {
  test("maps bare codes to BCP-47", () => {
    expect(toLocale("en")).toBe("en-US")
    expect(toLocale("zh")).toBe("zh-CN")
  })

  test("passes through already-tagged locales", () => {
    expect(toLocale("en-GB")).toBe("en-GB")
  })
})
