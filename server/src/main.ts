import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { YouTrackClient } from "@nitpick/core"
import { createApp } from "./app.ts"
import { loadConfig } from "./config.ts"
import { makeLocalDeviceHost } from "./device/LocalDeviceHost.ts"
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
})

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`nitpick server on http://${config.host}:${config.port}`)
})
