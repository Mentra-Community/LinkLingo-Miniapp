import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {currentRequestContext} from "../observability/context"
import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {buildReport, reportPeriod} from "../services/history-report"
import {HISTORY_RETENTION_DAYS, historyStore} from "../services/history-store"
import {digest} from "../services/review-log"
import type {ReportRange} from "../shared-types"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("reports.api")

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const reportsApi = new Hono<{Variables: MentraAuthVariables}>()

reportsApi.use("*", mentraAuthMiddleware())

/**
 * GET /api/reports?range=day|week&tzOffsetMin=-480&date=YYYY-MM-DD
 *
 * Always the caller's own ledger: the user comes from the verified token,
 * never from the query, so one learner cannot read another's words.
 */
reportsApi.get("/", async (c) => {
  const userId = currentRequestContext()?.userId
  if (!userId) return c.json({error: "Sign-in required"}, 401)

  const range = (c.req.query("range") ?? "day") as ReportRange
  if (range !== "day" && range !== "week") return c.json({error: "range must be day or week"}, 400)
  const tz = Number(c.req.query("tzOffsetMin") ?? 0)
  if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60) return c.json({error: "invalid tzOffsetMin"}, 400)
  const date = c.req.query("date")
  if (date && (!DATE.test(date) || Number.isNaN(Date.parse(date)))) return c.json({error: "date must be YYYY-MM-DD"}, 400)

  const started = Date.now()
  const user = digest(userId)
  const period = reportPeriod(range, date, tz)
  try {
    const [events, before] = await Promise.all([
      historyStore.events(user, period.from, period.to),
      historyStore.events(user, period.from - HISTORY_RETENTION_DAYS * DAY_MS, period.from - 1),
    ])
    const report = buildReport(period, events, before)
    metrics.increment("reports_total", {range, outcome: "ok"})
    metrics.observe("reports_duration", Date.now() - started)
    return c.json(report)
  } catch (error) {
    metrics.increment("reports_total", {range, outcome: "error"})
    log.error("report failed", {range, error})
    return c.json({error: "Report unavailable"}, 500)
  }
})
