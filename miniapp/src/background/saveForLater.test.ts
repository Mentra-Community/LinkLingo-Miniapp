import {describe, expect, test} from "bun:test"

import {extractSaveForLater} from "./saveForLater"

describe("extractSaveForLater", () => {
  test("accepts the documented spoken format", () => {
    expect(extractSaveForLater("Link Lingo, save for later: I need to reschedule the meeting.")).toMatchObject({
      text: "I need to reschedule the meeting.",
      usedPrevious: false,
      matchedBy: "wake_word",
    })
  })

  test("accepts loose natural variants instead of one strict command", () => {
    const variants = [
      "Hey Lingo, could you keep this phrase: I can't make it tomorrow.",
      "Please remember this for later — We need a backup plan.",
      "I want you to save this sentence: I missed the train.",
      "Can you note down for later, I need more time to decide.",
      "LinkLingo remember I should follow up next week.",
    ]
    expect(variants.map((value) => extractSaveForLater(value)?.text)).toEqual([
      "I can't make it tomorrow.",
      "We need a backup plan.",
      "I missed the train.",
      "I need more time to decide.",
      "I should follow up next week.",
    ])
  })

  test("a referential command saves the previous final sentence", () => {
    expect(extractSaveForLater("Link Lingo, save this sentence.", "I need to push the deadline back.")).toMatchObject({
      text: "I need to push the deadline back.",
      usedPrevious: true,
    })
  })

  test("does not match ordinary speech that merely discusses saving", () => {
    expect(extractSaveForLater("I saved that sentence yesterday.")).toBeNull()
    expect(extractSaveForLater("We should save money for later.")).toBeNull()
    expect(extractSaveForLater("Remember when we rescheduled the meeting?")).toBeNull()
  })
})
