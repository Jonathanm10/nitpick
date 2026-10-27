import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { makeLocalDeviceHost } from "./device/LocalDeviceHost.ts"
import { nodeSubprocessRunner } from "./subprocess.ts"

const config = loadConfig(process.env)
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url))
const hasWebBuild = existsSync(webRoot)
if (!hasWebBuild) {
  console.log("No web/dist yet, so only /api is served; `pnpm build` makes it.")
}

const app = createApp({
  deviceHost: makeLocalDeviceHost(nodeSubprocessRunner),
  webRoot: hasWebBuild ? webRoot : undefined,
})

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`nitpick server on http://${config.host}:${config.port}`)
})
