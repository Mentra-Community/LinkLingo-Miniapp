import {createApp} from "./api/app"
import {createLogger, logFormat, logLevel} from "./observability/logger"
import {metrics} from "./observability/metrics"
import {apiKeyFingerprint, allowMockLlm, resolveApiKeySource, resolveModel} from "./services/gemini"
import {allowUnauth} from "./api/auth"

const log = createLogger("server")

export interface StartBackendOptions {
  port?: number
}

export interface BackendHandle {
  port: number
  url: string
  stop(): Promise<void>
}

/** Emitted once at boot so a pod's effective configuration is never a guess. */
function logStartupConfig(port: number): void {
  log.info("startup configuration", {
    port,
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    package: process.env.PACKAGE_NAME ?? "com.mentra.link",
    model: resolveModel(),
    llmKeySource: resolveApiKeySource() ?? "(none)",
    llmKeyFingerprint: apiKeyFingerprint() ?? "(none)",
    allowMockLlm: allowMockLlm(),
    allowUnauth: allowUnauth(),
    logLevel: logLevel(),
    logFormat: logFormat(),
    bunVersion: Bun.version,
  })
  if (!resolveApiKeySource()) {
    log.error("no LLM API key configured; every gloss and upgrade request will fail with 503")
  }
}

export async function startBackend(opts: StartBackendOptions = {}): Promise<BackendHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3240", 10)
  const app = createApp()
  const server = Bun.serve({port, fetch: app.fetch})
  const boundPort = server.port!

  logStartupConfig(boundPort)
  log.info("listening", {url: `http://localhost:${boundPort}`})

  return {
    port: boundPort,
    url: `http://localhost:${boundPort}`,
    async stop() {
      server.stop()
    },
  }
}

if (import.meta.main) {
  const handle = await startBackend()

  process.on("uncaughtException", (error) => {
    log.error("uncaught exception", {error, stack: error.stack})
  })
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", {reason: String(reason)})
  })

  const shutdown = async (signal: string) => {
    // Dumping counters on the way out preserves the traffic picture for a pod
    // that is about to disappear.
    const snapshot = metrics.snapshot()
    log.info("shutdown requested", {
      signal,
      uptimeSeconds: snapshot.uptimeSeconds,
      counters: snapshot.counters,
    })
    await handle.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
