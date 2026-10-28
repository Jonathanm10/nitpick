import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { YouTrackClient } from "@nitpick/core"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { makeLocalDeviceHost } from "./device/LocalDeviceHost.ts"
import { DeviceHub, spawnPinnedHub } from "./device/deviceHub.ts"
import { hubUpgradeHandler } from "./device/deviceHubProxy.ts"
import { fetchTransport } from "./fetchTransport.ts"
import { HistoryStore } from "./historyStore.ts"
import { Reviewer } from "./reviewer.ts"
import { nodeSubprocessRunner } from "./subprocess.ts"
import { readServerVersion } from "./version.ts"

/** Until sign-in exists (issue 10), the server has one Reviewer. */
const interimReviewerID = "interim"

const config = loadConfig(process.env)
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url))
const hasWebBuild = existsSync(webRoot)
if (!hasWebBuild) {
  console.log("No web/dist yet, so only /api is served; `pnpm build` makes it.")
}
if (config.youTrack === undefined) {
  console.log(
    "No NITPICK_YOUTRACK_URL and NITPICK_YOUTRACK_TOKEN, so no projects can be picked."
  )
}

// The hub streams the devices only behind the proxy's access check, so
// without a token to check there's nothing to start.
const deviceHub =
  config.streamAccess &&
  new DeviceHub({
    spawn: spawnPinnedHub,
    log: (line) => console.log(`[device hub] ${line}`),
  })
if (deviceHub === undefined) {
  console.log("No NITPICK_ACCESS_TOKEN, so the device stream is off.")
} else {
  deviceHub.start()
}

const deviceHost = makeLocalDeviceHost(
  nodeSubprocessRunner,
  join(config.dataDirectory, "captures")
)
const youTrack =
  config.youTrack && new YouTrackClient(fetchTransport, config.youTrack)
const history = new HistoryStore(join(config.dataDirectory, "history"))
const reviewer = new Reviewer(
  join(config.dataDirectory, "reviewers", interimReviewerID),
  { deviceHost, runner: nodeSubprocessRunner, youTrack, history }
)

// A File all the server's last run didn't finish picks up where its saved
// marks stop, before the port opens, so no page sees it idle meanwhile.
const resumed = await reviewer.resumeInterruptedFiling()
if (resumed !== undefined) {
  console.log("Resuming the File all a restart interrupted.")
}

const app = createApp({
  deviceHost,
  reviewer,
  youTrack,
  history,
  serverVersion: await readServerVersion(nodeSubprocessRunner),
  webRoot: hasWebBuild ? webRoot : undefined,
  streamAccess: config.streamAccess,
  deviceStream: deviceHub,
})

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  () => {
    console.log(`nitpick server on http://${config.host}:${config.port}`)
  }
)
// The device's input socket goes through the proxy as well.
server.on("upgrade", hubUpgradeHandler(config.streamAccess, deviceHub))

// The hub is the server's child: it stops with the server.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close()
    void (deviceHub?.stop() ?? Promise.resolve()).then(() => process.exit(0))
  })
}
process.once("exit", () => deviceHub?.stopNow())
