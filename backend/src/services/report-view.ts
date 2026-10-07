/**
 * The Reports tab, described as blocks. The phone draws whatever this
 * returns, so reordering sections, adding one, or rewording a hint is a
 * backend deploy.
 */

import type {Report, ReportWord} from "../shared-types"
import {BLOCK_KIT_VERSION, type View, type ViewBlock} from "../ui-blocks"
import {REPEAT_THRESHOLD} from "./history-report"

function weekday(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-US", {weekday: "short", timeZone: "UTC"})
}

function words(items: ReportWord[], withCount: boolean, tone?: "info" | "accent") {
  return items.map((w) => ({
    word: w.word,
    translation: w.translation,
    badge: withCount && w.count > 1 ? `×${w.count}` : undefined,
    tone,
  }))
}

/** `repeatThreshold` must be the one the report was built with; it only labels the section. */
export function buildReportView(report: Report, opts: {repeatThreshold?: number} = {}): View {
  const {totals, mistakes} = report
  const threshold = opts.repeatThreshold ?? REPEAT_THRESHOLD
  const repeats = mistakes.repeats
  const empty = totals.wordsShown === 0 && totals.fallbacks === 0 && totals.heard === 0 && mistakes.review.length === 0

  const summary: ViewBlock[] = [
    {
      type: "tiles",
      items: [
        {value: totals.wordsShown, label: "words shown"},
        {value: totals.newWords, label: "new words"},
        {value: totals.fallbacks, label: "words you reached for"},
        {value: totals.heard, label: "sentences heard"},
      ],
    },
  ]
  if (report.range === "week") {
    summary.push({
      type: "bars",
      label: "Words per day",
      items: report.days.map((d) => ({
        label: weekday(d.date),
        segments: [
          {value: d.words, tone: "accent"},
          {value: d.fallbacks, tone: "info"},
        ],
      })),
    })
  }
  if (empty) summary.push({type: "text", tone: "hint", text: "Nothing recorded for this period. Wear the glasses and it fills in."})

  const blocks: ViewBlock[] = [{type: "section", blocks: summary}]

  if (report.topWords.length > 0 || report.newWords.length > 0) {
    blocks.push({
      type: "section",
      title: "Words",
      meta: `${totals.uniqueWords} different`,
      blocks: [
        {type: "words", title: "Most seen", items: words(report.topWords, true)},
        ...(report.newWords.length > 0 ? [{type: "words" as const, title: "New this period", items: words(report.newWords, false)}] : []),
      ],
    })
  }

  blocks.push({
    type: "section",
    title: "Mistakes",
    blocks: [
      {
        type: "words",
        title: "Words you couldn't say",
        hint: "You reached for these mid-sentence",
        empty: "None — you stayed in the language.",
        items: words(mistakes.fallbacks, true, "info"),
      },
      {
        type: "words",
        title: "Not sticking yet",
        hint: `Glossed ${threshold} or more times`,
        empty: "Nothing repeated often enough yet.",
        items: words(repeats, true),
      },
      {
        type: "list",
        title: "Things you flagged",
        empty: "Nothing flagged from the comment box.",
        items: mistakes.flags.map((f) => ({text: f.note, detail: f.change ? `change ${f.change}` : undefined})),
      },
      {
        type: "list",
        title: "Possible errors",
        hint: "From a daily AI review of what the glasses heard. It cannot tell your voice from others, so treat these as guesses.",
        empty: "No review yet for this period.",
        items: mistakes.review.map((r) => ({
          was: r.said,
          text: r.better,
          detail: r.rule,
          tone: r.confidence === "low" ? ("muted" as const) : undefined,
        })),
      },
    ],
  })

  return {kit: BLOCK_KIT_VERSION, blocks}
}
