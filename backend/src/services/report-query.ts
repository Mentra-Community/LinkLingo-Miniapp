import type {Context} from "hono"

import {currentRequestContext} from "../observability/context"
import type {Report, ReportRange} from "../shared-types"
import {buildReport, REPEAT_THRESHOLD, reportPeriod} from "./history-report"
import {HISTORY_RETENTION_DAYS, historyStore} from "./history-store"
import {digest} from "./review-log"

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** From the learner's `prefs.repeatThreshold` setting, clamped so a typo cannot hide the section. */
export function repeatThreshold(): number {
  const raw = Number(currentRequestContext()?.prefs?.repeatThreshold)
  return Number.isInteger(raw) && raw >= 2 && raw <= 10 ? raw : REPEAT_THRESHOLD
}

/**
 * Always the caller's own ledger: the user comes from the verified token,
 * never from the query, so one learner cannot read another's words.
 */
export async function loadReport(c: Context, threshold = repeatThreshold()): Promise<Report | Response> {
  const userId = currentRequestContext()?.userId
  if (!userId) return c.json({error: "Sign-in required"}, 401)

  const range = (c.req.query("range") ?? "day") as ReportRange
  if (range !== "day" && range !== "week") return c.json({error: "range must be day or week"}, 400)
  const tz = Number(c.req.query("tzOffsetMin") ?? 0)
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) return c.json({error: "invalid tzOffsetMin"}, 400)
  const date = c.req.query("date")
  if (date && (!DATE.test(date) || Number.isNaN(Date.parse(date)))) return c.json({error: "date must be YYYY-MM-DD"}, 400)

  const user = digest(userId)
  const period = reportPeriod(range, date, tz)
  const [events, before] = await Promise.all([
    historyStore.events(user, period.from, period.to),
    historyStore.events(user, period.from - HISTORY_RETENTION_DAYS * DAY_MS, period.from - 1),
  ])
  return buildReport(period, events, before, {repeatThreshold: threshold})
}
