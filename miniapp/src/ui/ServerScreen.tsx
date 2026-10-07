import {useEffect, useState} from "react"

import type {AppConfig, View} from "../shared/blocks"
import {ViewBlocks, type BlockContext} from "./Blocks"

type Screen = AppConfig["screens"][number]
type Range = "day" | "week"

const DAY_MS = 86_400_000

function todayLocal(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

function periodLabel(range: Range, date: string): string {
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

/**
 * Any tab the server lists in its config. The phone draws the blocks the
 * server returns; with `period` it adds the day/week picker and sends it
 * along. A new tab needs a backend deploy, not a new install.
 */
export function ServerScreen({screen, ctx}: {screen: Screen; ctx: BlockContext}) {
  const [range, setRange] = useState<Range>("day")
  const [date, setDate] = useState(todayLocal)
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setLoading(true)
    setError(null)
    const off = mentra.on("link:view-result", (payload) => {
      if (payload.requestId !== requestId) return
      setLoading(false)
      if (payload.ok && payload.view) setView(payload.view)
      else setError(payload.error ?? "Unavailable")
    })
    const query: Record<string, string> = screen.period
      ? {range, date, tzOffsetMin: String(new Date().getTimezoneOffset())}
      : {}
    mentra.send("link:view-request", {requestId, screen: screen.id, query})
    return off
  }, [screen.id, screen.period, range, date])

  const step = range === "week" ? 7 : 1

  return (
    <div className={`stack${loading && view ? " stale" : ""}`}>
      {screen.period ? (
        <section className="card">
          <div className="seg two" role="tablist" aria-label="Report period">
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
              disabled={date >= todayLocal()}
              onClick={() => setDate((d) => shiftDate(d, step))}>
              ›
            </button>
          </div>
        </section>
      ) : null}

      {error ? (
        <section className="card">
          <div className="diag-error">
            <strong>{`No ${screen.title.toLowerCase()}`}</strong>
            <span>{error}</span>
          </div>
        </section>
      ) : view ? (
        <ViewBlocks blocks={view.blocks} ctx={ctx} />
      ) : (
        <section className="card">
          <p className="hint">Loading…</p>
        </section>
      )}
    </div>
  )
}
