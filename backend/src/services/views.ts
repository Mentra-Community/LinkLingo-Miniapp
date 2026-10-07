import type {Context} from "hono"

import type {View} from "../ui-blocks"
import {loadReport, repeatThreshold} from "./report-query"
import {buildReportView} from "./report-view"

export type ViewBuilder = (c: Context) => Promise<View | Response>

/**
 * One builder per tab listed in `screens` (app-config.ts). A new screen is a
 * builder here plus an entry there; the phone needs nothing new.
 */
export const VIEWS: Record<string, ViewBuilder> = {
  reports: async (c) => {
    const threshold = repeatThreshold()
    const report = await loadReport(c, threshold)
    return report instanceof Response ? report : buildReportView(report, {repeatThreshold: threshold})
  },
}
