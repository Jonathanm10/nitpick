import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import type { DevicesResponse, ErrorResponse } from "./api.ts"
import type { DeviceHost } from "./device/DeviceHost.ts"

export interface AppOptions {
  readonly deviceHost: DeviceHost
  /** The built web app. Omitted in development, where Vite serves it. */
  readonly webRoot?: string
}

export function createApp({ deviceHost, webRoot }: AppOptions): Hono {
  const app = new Hono()

  app.get("/api/devices", async (c) => {
    try {
      const devices = await deviceHost.devices.list()
      return c.json({ devices } satisfies DevicesResponse)
    } catch (error) {
      console.error(error)
      const message =
        error instanceof Error
          ? error.message
          : "The devices could not be listed."
      return c.json({ error: message } satisfies ErrorResponse, 500)
    }
  })

  if (webRoot !== undefined) {
    app.use("/*", serveStatic({ root: webRoot }))
  }

  return app
}
