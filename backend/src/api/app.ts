import {Hono} from "hono"
import {cors} from "hono/cors"

import {glossService} from "../services/gloss.service"
import {glossApi} from "./gloss.api"
import {upgradeApi} from "./upgrade.api"

export function createApp(): Hono {
  const app = new Hono()

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  )

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      service: "linklingo-miniapp-backend",
      package: process.env.PACKAGE_NAME ?? "com.mentra.link",
      model: glossService.model,
    }),
  )

  app.route("/api/gloss", glossApi)
  app.route("/api/upgrade", upgradeApi)

  return app
}
