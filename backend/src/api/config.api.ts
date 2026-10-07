import {Hono} from "hono"
import type {MentraAuthVariables} from "@mentra/auth"

import {metrics} from "../observability/metrics"
import {buildAppConfig} from "../services/app-config"
import {mentraAuthMiddleware} from "./auth"

export const configApi = new Hono<{Variables: MentraAuthVariables}>()

configApi.use("*", mentraAuthMiddleware())

/** GET /api/config — settings rows, tunables and pref defaults the phone runs on until the next fetch. */
configApi.get("/", (c) => {
  metrics.increment("config_requests_total")
  return c.json(buildAppConfig())
})
