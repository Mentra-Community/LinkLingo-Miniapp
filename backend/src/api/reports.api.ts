import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {createLogger} from "../observability/logger"
import {metrics} from "../observability/metrics"
import {loadReport} from "../services/report-query"
import {mentraAuthMiddleware} from "./auth"

const log = createLogger("reports.api")

export const reportsApi = new Hono<{Variables: MentraAuthVariables}>()

reportsApi.use("*", mentraAuthMiddleware())

/**
 * GET /api/reports?range=day|week&tzOffsetMin=-480&date=YYYY-MM-DD — the
 * aggregate as data. The Reports tab draws `/api/views/reports` instead.
 */
reportsApi.get("/", async (c) => {
  const range = c.req.query("range") ?? "day"
  try {
    const report = await loadReport(c)
    if (report instanceof Response) return report
    metrics.increment("reports_total", {range, outcome: "ok"})
    return c.json(report)
  } catch (error) {
    metrics.increment("reports_total", {range, outcome: "error"})
    log.error("report failed", {range, error})
    return c.json({error: "Report unavailable"}, 500)
  }
})
