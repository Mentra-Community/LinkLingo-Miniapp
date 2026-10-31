import type {Context} from "hono"

import type {View} from "../ui-blocks"
import {getLearningService, identityOf, phoneStatuses} from "./learning-runtime"
import {buildLearningView} from "./learning-view"
import {userKeyFor, type LearningStatus} from "./learning-outbox"
import {loadReport, repeatThreshold} from "./report-query"
import {buildReportView} from "./report-view"

export type ViewBuilder = (c: Context) => Promise<View | Response>

/**
 * One builder per tab listed in `screens` (app-config.ts). A new screen is a
 * builder here plus an entry there; the phone needs nothing new.
 */
export const VIEWS: Record<string, ViewBuilder> = {
  learning: async (c) => {
    const service = getLearningService()
    const identity = identityOf(c)
    const status: LearningStatus = service
      ? await service.status(identity)
      : {
          enabled: false,
          problem: "Learning capture is not enabled on this server.",
          connected: false,
          label: null,
          environment: null,
          lastAcceptedAt: null,
          pendingServerEvents: 0,
          lastError: null,
        }
    return buildLearningView({status, phone: phoneStatuses.get(userKeyFor(identity)) ?? null})
  },
  reports: async (c) => {
    const threshold = repeatThreshold()
    const report = await loadReport(c, threshold)
    return report instanceof Response ? report : buildReportView(report, {repeatThreshold: threshold})
  },
}
