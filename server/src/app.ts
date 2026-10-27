import { serveStatic } from "@hono/node-server/serve-static"
import {
  ShellBusy,
  unfiledFindingCount,
  verifyYouTrack,
  YouTrackError,
  type Build,
  type RecentDevices,
  type ReviewSession,
  type YouTrackClient,
} from "@nitpick/core"
import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ReadableStream } from "node:stream/web"
import type {
  BuildResponse,
  BuildSummary,
  DevicesResponse,
  ErrorResponse,
  HostResponse,
  ProjectsResponse,
  ReadyHost,
  ReviewStateResponse,
  SessionSummary,
  StartReviewResponse,
  SwitchDeviceResponse,
} from "./api.ts"
import { BuildIngestError, buildName } from "./buildIngestion.ts"
import type { DeviceHost, SimulatorDevice } from "./device/DeviceHost.ts"
import { hostProblemReason } from "./device/hostHealth.ts"
import { RuntimeUnavailable } from "./device/simctl.ts"
import { ReviewRefused, type Reviewer } from "./reviewer.ts"

export interface AppOptions {
  readonly deviceHost: DeviceHost
  /** Until sign-in exists (issue 10), every request acts for this Reviewer. */
  readonly reviewer: Reviewer
  /** Undefined when the server has no YouTrack connection configured. */
  readonly youTrack: YouTrackClient | undefined
  /** The built web app. Omitted in development, where Vite serves it. */
  readonly webRoot?: string
}

export function createApp({
  deviceHost,
  reviewer,
  youTrack,
  webRoot,
}: AppOptions): Hono {
  const app = new Hono()

  app.get("/api/devices", async (c) => {
    const devices = await deviceHost.devices.list()
    return c.json({ devices } satisfies DevicesResponse)
  })

  app.get("/api/host", async (c) => {
    const status = await reviewer.hostStatus()
    return c.json(
      (status.status === "ready"
        ? readyHost(status.devices, status.recentDevices)
        : {
            status: "notReady",
            reason: hostProblemReason(status.problem),
          }) satisfies HostResponse
    )
  })

  app.get("/api/projects", async (c) => {
    if (youTrack === undefined) {
      return c.json(
        {
          error:
            "The nitpick server has no YouTrack connection configured, so it can't list projects.",
        } satisfies ErrorResponse,
        503
      )
    }
    const { projects } = await verifyYouTrack(youTrack)
    return c.json({ projects } satisfies ProjectsResponse)
  })

  app.get("/api/review", async (c) => {
    const { build, session } = await reviewer.state()
    return c.json({
      build: build && buildSummary(build),
      session: session && sessionSummary(session),
    } satisfies ReviewStateResponse)
  })

  app.post("/api/build", async (c) => {
    const build = await reviewer.ingest(
      c.req.raw.body as ReadableStream<Uint8Array> | null,
      c.req.query("name") ?? ""
    )
    return c.json({ build: buildSummary(build) } satisfies BuildResponse)
  })

  app.post("/api/session", async (c) => {
    const body = await jsonBody(c)
    const projectID = body.projectID
    if (projectID !== undefined && typeof projectID !== "string") {
      throw malformedRequest()
    }
    const outcome = await reviewer.start({
      deviceUDID: deviceUDID(body),
      projectID,
    })
    return c.json(
      (outcome.status === "started"
        ? {
            status: "started",
            session: sessionSummary(outcome.session),
            device: outcome.device,
            schema: outcome.schema,
            host: readyHost(outcome.devices, outcome.recentDevices),
          }
        : {
            status: "notReady",
            reason: hostProblemReason(outcome.problem),
          }) satisfies StartReviewResponse
    )
  })

  app.put("/api/session/device", async (c) => {
    const { device, recentDevices } = await reviewer.switchDevice(
      deviceUDID(await jsonBody(c))
    )
    return c.json({
      device,
      recentDeviceUDIDs: recentDevices.udids,
    } satisfies SwitchDeviceResponse)
  })

  app.delete("/api/session", async (c) => {
    await reviewer.end()
    return c.body(null, 204)
  })

  app.onError((error, c) => {
    const status = errorStatus(error)
    if (status === 500) console.error(error)
    const message =
      error instanceof Error && error.message !== ""
        ? error.message
        : "The nitpick server failed to answer."
    return c.json({ error: message } satisfies ErrorResponse, status)
  })

  if (webRoot !== undefined) {
    app.use("/*", serveStatic({ root: webRoot }))
  }

  return app
}

/** Refusals the Reviewer can act on keep their message; the rest are 500s. */
function errorStatus(error: unknown): ContentfulStatusCode {
  if (error instanceof HTTPException) return 400
  if (error instanceof BuildIngestError) return 400
  if (
    error instanceof ShellBusy ||
    error instanceof ReviewRefused ||
    error instanceof RuntimeUnavailable
  ) {
    return 409
  }
  if (error instanceof YouTrackError) return 502
  return 500
}

function malformedRequest(): HTTPException {
  return new HTTPException(400, { message: "The request is malformed." })
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => undefined)
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw malformedRequest()
  }
  return body as Record<string, unknown>
}

function deviceUDID(body: Record<string, unknown>): string {
  if (typeof body.deviceUDID !== "string") throw malformedRequest()
  return body.deviceUDID
}

function buildSummary(build: Build): BuildSummary {
  return { name: buildName(build), identity: build.identity }
}

function sessionSummary(session: ReviewSession): SessionSummary {
  return {
    project: session.project,
    startedAt: session.startedAt,
    unfiledFindingCount: unfiledFindingCount(session),
  }
}

function readyHost(
  devices: ReadonlyArray<SimulatorDevice>,
  recentDevices: RecentDevices
): ReadyHost {
  return { status: "ready", devices, recentDeviceUDIDs: recentDevices.udids }
}
