import {createApp} from "./api/app"

export interface StartBackendOptions {
  port?: number
}

export interface BackendHandle {
  port: number
  url: string
  stop(): Promise<void>
}

export async function startBackend(opts: StartBackendOptions = {}): Promise<BackendHandle> {
  const port = opts.port ?? Number.parseInt(process.env.PORT ?? "3240", 10)
  const app = createApp()
  const server = Bun.serve({port, fetch: app.fetch})
  const boundPort = server.port!

  console.log(`LinkLingo backend listening on http://localhost:${boundPort}`)

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
  const shutdown = async (signal: string) => {
    console.log(`LinkLingo backend shutdown requested: ${signal}`)
    await handle.stop()
    process.exit(0)
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
