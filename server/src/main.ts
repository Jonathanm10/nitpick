import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { makeLocalDeviceHost } from "./device/LocalDeviceHost.ts"
import { androidSDK, ffmpegPath } from "./device/android.ts"
import { DeviceClaims } from "./device/deviceClaims.ts"
import { DeviceHub, spawnPinnedHub } from "./device/deviceHub.ts"
import { hubUpgradeHandler } from "./device/deviceHubProxy.ts"
import { fetchTransport } from "./fetchTransport.ts"
import { HistoryStore } from "./historyStore.ts"
import { Reviewers } from "./reviewers.ts"
import { SignInStore } from "./signInStore.ts"
import { nodeProcessStarter, nodeSubprocessRunner } from "./subprocess.ts"
import { readServerVersion } from "./version.ts"

const config = loadConfig(process.env)
if (config.youTrackURL === undefined) {
  console.error(
    "Set NITPICK_YOUTRACK_URL: Reviewers sign in to that YouTrack instance."
  )
  process.exit(1)
}
const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url))
const hasWebBuild = existsSync(webRoot)
if (!hasWebBuild) {
  console.log("No web/dist yet, so only /api is served; `pnpm build` makes it.")
}

const signIns = new SignInStore(config.dataDirectory, config.youTrackURL)
await signIns.load()

// The hub and the server find the same Android SDK and ffmpeg.
const android = androidSDK(process.env)
const ffmpeg = await ffmpegPath(process.env)
const deviceHub = new DeviceHub({
  spawn: (port) => spawnPinnedHub(port, { android, ffmpeg }),
  log: (line) => console.log(`[device hub] ${line}`),
})
deviceHub.start()

const deviceHost = makeLocalDeviceHost({
  runner: nodeSubprocessRunner,
  starter: nodeProcessStarter,
  captureDirectory: join(config.dataDirectory, "captures"),
  android,
  ffmpeg,
})
const history = new HistoryStore(join(config.dataDirectory, "history"))
const deviceClaims = new DeviceClaims({
  limit: config.maxBootedDevices,
  list: deviceHost.devices.list,
  shutDown: deviceHost.shutDown,
})
const reviewers = new Reviewers({
  directory: join(config.dataDirectory, "reviewers"),
  instanceURL: config.youTrackURL,
  transport: fetchTransport,
  signIns,
  dependencies: {
    deviceHost,
    runner: nodeSubprocessRunner,
    history,
    deviceClaims,
  },
})

// A File all the server's last run didn't finish picks up where its saved
// marks stop, before the port opens, so no page sees it idle meanwhile.
const resumed = await reviewers.resumeInterruptedFilings()
if (resumed > 0) {
  console.log("Resuming the File all a restart interrupted.")
}

const app = createApp({
  deviceHost,
  reviewers,
  history,
  serverVersion: await readServerVersion(nodeSubprocessRunner),
  webRoot: hasWebBuild ? webRoot : undefined,
  deviceStream: deviceHub,
})

const server = serve(
  { fetch: app.fetch, hostname: config.host, port: config.port },
  () => {
    console.log(`nitpick server on http://${config.host}:${config.port}`)
  }
)
// The device's input socket goes through the proxy as well.
server.on(
  "upgrade",
  hubUpgradeHandler((header) => reviewers.admit(header), deviceHub)
)

// The hub is the server's child: it stops with the server.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close()
    void deviceHub.stop().then(() => process.exit(0))
  })
}
process.once("exit", () => deviceHub.stopNow())
