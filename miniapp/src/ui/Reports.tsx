import {useEffect, useState} from "react"

import type {Report, ReportRange, ReportWord} from "../shared/types"

const DAY_MS = 86_400_000

function todayLocal(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function weekday(date: string): string {
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString(undefined, {weekday: "short", timeZone: "UTC"})
}

function periodLabel(range: ReportRange, date: string): string {
  const today = todayLocal()
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00.000Z`).toLocaleDateString(undefined, {month: "short", day: "numeric", timeZone: "UTC"})
  if (range === "day") {
    if (date === today) return "Today"
    if (date === shiftDate(today, -1)) return "Yesterday"
    return fmt(date)
  }
  return date === today ? "Last 7 days" : `${fmt(shiftDate(date, -6))} – ${fmt(date)}`
}

/** One day or one week of what the glasses taught you, and where you got stuck. */
export function Reports() {
  const [range, setRange] = useState<ReportRange>("day")
  const [date, setDate] = useState(todayLocal)
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setLoading(true)
    setError(null)
    const off = mentra.on("link:reports-result", (payload) => {
      if (payload.requestId !== requestId) return
      setLoading(false)
      if (payload.ok && payload.report) setReport(payload.report)
      else setError(payload.error ?? "Report unavailable")
    })
    mentra.send("link:reports-request", {requestId, range, date, tzOffsetMin: new Date().getTimezoneOffset()})
    return off
  }, [range, date])

  const step = range === "week" ? 7 : 1
  const atToday = date >= todayLocal()

  return (
    <div className="stack">
      <section className="card">
        <div className="seg" role="tablist" aria-label="Report period">
          {(["day", "week"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={range === r}
              className={range === r ? "on" : ""}
              onClick={() => setRange(r)}>
              {r === "day" ? "Day" : "Week"}
            </button>
          ))}
        </div>
        <div className="period">
          <button type="button" className="ghost" aria-label="Earlier" onClick={() => setDate((d) => shiftDate(d, -step))}>
            ‹
          </button>
          <strong>{periodLabel(range, date)}</strong>
          <button
            type="button"
            className="ghost"
            aria-label="Later"
            disabled={atToday}
            onClick={() => setDate((d) => shiftDate(d, step))}>
            ›
          </button>
        </div>
      </section>

      {error ? (
        <section className="card">
          <div className="diag-error">
            <strong>No report</strong>
            <span>{error}</span>
          </div>
        </section>
      ) : !report ? (
        <section className="card">
          <p className="hint">{loading ? "Loading…" : "No report yet."}</p>
        </section>
      ) : (
        <ReportBody report={report} loading={loading} />
      )}
    </div>
  )
}

function ReportBody({report, loading}: {report: Report; loading: boolean}) {
  const {totals, mistakes} = report
  const empty = totals.wordsShown === 0 && totals.fallbacks === 0 && totals.heard === 0 && mistakes.review.length === 0
  const peak = Math.max(1, ...report.days.map((d) => d.words + d.fallbacks))

  return (
    <>
      <section className={`card${loading ? " stale" : ""}`}>
        <div className="tiles">
          <Tile value={totals.wordsShown} label="words shown" />
          <Tile value={totals.newWords} label="new words" />
          <Tile value={totals.fallbacks} label="words you reached for" />
          <Tile value={totals.heard} label="sentences heard" />
        </div>
        {report.range === "week" ? (
          <div className="bars" aria-label="Words per day">
            {report.days.map((day) => (
              <div key={day.date} className="bar-col">
                <div className="bar-track">
                  <div className="bar fallback" style={{height: `${(day.fallbacks / peak) * 100}%`}} />
                  <div className="bar" style={{height: `${(day.words / peak) * 100}%`}} />
                </div>
                <span>{weekday(day.date)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {empty ? <p className="hint">Nothing recorded for this period. Wear the glasses and it fills in.</p> : null}
      </section>

      {report.topWords.length > 0 || report.newWords.length > 0 ? (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Words</h2>
            <span className="meta">{`${totals.uniqueWords} different`}</span>
          </div>
          <WordList title="Most seen" words={report.topWords} showCount />
          <WordList title="New this period" words={report.newWords} />
        </section>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Mistakes</h2>
        </div>
        <WordList
          title="Words you couldn't say"
          hint="You reached for these mid-sentence"
          words={mistakes.fallbacks}
          showCount
          empty="None — you stayed in the language."
        />
        <WordList
          title="Not sticking yet"
          hint="Glossed 3 or more times"
          words={mistakes.repeats}
          showCount
          empty="Nothing repeated often enough yet."
        />
        <div className="report-group">
          <h3>Things you flagged</h3>
          {mistakes.flags.length === 0 ? (
            <p className="hint">Nothing flagged from the comment box.</p>
          ) : (
            <ul className="report-list">
              {mistakes.flags.map((flag) => (
                <li key={flag.at}>
                  <span>{flag.note}</span>
                  {flag.change ? <small>{`change ${flag.change}`}</small> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="report-group">
          <h3>Possible errors</h3>
          <p className="hint">From a daily AI review of what the glasses heard. It cannot tell your voice from others, so treat these as guesses.</p>
          {mistakes.review.length === 0 ? (
            <p className="hint">No review yet for this period.</p>
          ) : (
            <ul className="report-list">
              {mistakes.review.map((item, i) => (
                <li key={`${item.at}-${i}`} className={`confidence-${item.confidence}`}>
                  <span>
                    <s>{item.said}</s> → <b>{item.better}</b>
                  </span>
                  <small>{item.rule}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  )
}

function Tile({value, label}: {value: number; label: string}) {
  return (
    <div className="tile">
      <b>{value.toLocaleString()}</b>
      <span>{label}</span>
    </div>
  )
}

function WordList({
  title,
  hint,
  words,
  showCount,
  empty,
}: {
  title: string
  hint?: string
  words: ReportWord[]
  showCount?: boolean
  empty?: string
}) {
  if (words.length === 0 && !empty) return null
  return (
    <div className="report-group">
      <h3>{title}</h3>
      {hint ? <p className="hint">{hint}</p> : null}
      {words.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <div className="words">
          {words.map((word) => (
            <div key={`${word.word}-${word.lastAt}`} className="word-chip">
              <b>
                {word.word}
                {showCount && word.count > 1 ? <em className="count">{`×${word.count}`}</em> : null}
              </b>
              <small>{word.translation}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
