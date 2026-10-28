import { serveStatic } from "@hono/node-server/serve-static"
import {
  annotationColors,
  designSnapshotContentType,
  DesignSnapshotError,
  sendFeedback,
  ShellBusy,
  verifyYouTrack,
  YouTrackError,
  type Build,
  type RecentDevices,
  type ReviewSession,
  type YouTrackClient,
} from "@nitpick/core"
import { Hono, type Context } from "hono"
import { bodyLimit } from "hono/body-limit"
import { HTTPException } from "hono/http-exception"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { ReadableStream } from "node:stream/web"
import type {
  BuildResponse,
  BuildSummary,
  CaptureResponse,
  DesignSnapshotResponse,
  DevicesResponse,
  ErrorResponse,
  FeedbackEnvironmentResponse,
  FeedbackResponse,
  FilingResponse,
  HistoryResponse,
  HostResponse,
  ProjectsResponse,
  ReadyHost,
  ReviewStateResponse,
  SessionSummary,
  StartReviewResponse,
  SwitchDeviceResponse,
} from "./api.ts"
import {
  annotatedScreenshotPNG,
  labelSpritePNG,
} from "./annotationFlattening.ts"
import { BuildIngestError, buildName } from "./buildIngestion.ts"
import type { DeviceHost, SimulatorDevice } from "./device/DeviceHost.ts"
import { hostProblemReason } from "./device/hostHealth.ts"
import { DeviceNotRunning, RuntimeUnavailable } from "./device/simctl.ts"
import {
  feedbackImagePNG,
  MalformedFeedback,
  parseFeedbackRequest,
} from "./feedbackRequest.ts"
import {
  MalformedEdit,
  parseFindingPatch,
  parseSessionPatch,
} from "./findingPatch.ts"
import type { HistoryStore } from "./historyStore.ts"
import { FindingNotFound, ReviewRefused, type Reviewer } from "./reviewer.ts"

export interface AppOptions {
  readonly deviceHost: DeviceHost
  /** Until sign-in exists (issue 10), every request acts for this Reviewer. */
  readonly reviewer: Reviewer
  /** Undefined when the server has no YouTrack connection configured. */
  readonly youTrack: YouTrackClient | undefined
  /** The shared History every Reviewer reads. */
  readonly history: HistoryStore
  /** This server's version, for a Feedback's Environment. */
  readonly serverVersion: string
  /** The built web app. Omitted in development, where Vite serves it. */
  readonly webRoot?: string
}

export function createApp({
  deviceHost,
  reviewer,
  youTrack,
  history,
  serverVersion,
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
      return notConnected(c, "list projects")
    }
    const { projects } = await verifyYouTrack(youTrack)
    return c.json({ projects } satisfies ProjectsResponse)
  })

  app.get("/api/review", async (c) => {
    const { build, session, filing } = await reviewer.state()
    return c.json({
      build: build && buildSummary(build),
      session: session && sessionSummary(session),
      filing,
    } satisfies ReviewStateResponse)
  })

  // File all runs on the server: the answer comes at once, and the page
  // follows the run through /api/review.
  app.post("/api/session/filing", (c) => {
    void reviewer.fileAll()
    return c.json(
      { filing: reviewer.filingStatus() } satisfies FilingResponse,
      202
    )
  })

  app.delete("/api/filing-result", (c) => {
    reviewer.dismissFilingResult()
    return c.body(null, 204)
  })

  app.get("/api/history", async (c) => {
    const [entries, filer] = await Promise.all([
      history.entries(),
      // History reads only the server's files; not knowing who asks only
      // hides the home trace.
      reviewer.identity().catch(() => undefined),
    ])
    return c.json({ entries, reviewer: filer } satisfies HistoryResponse)
  })

  app.get("/api/feedback/environment", async (c) =>
    c.json({
      server: serverVersion,
      deviceHost: await deviceHost.versions(),
    } satisfies FeedbackEnvironmentResponse)
  )

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

  app.patch("/api/session", async (c) => {
    await reviewer.editSession(parseSessionPatch(await jsonBody(c)))
    return c.body(null, 204)
  })

  app.post("/api/session/captures", async (c) => {
    const item = await reviewer.capture(deviceUDID(await jsonBody(c)))
    return c.json({ item } satisfies CaptureResponse)
  })

  const finding = "/api/session/findings/:itemID"

  app.patch(finding, async (c) => {
    await reviewer.editFinding(
      c.req.param("itemID"),
      parseFindingPatch(await jsonBody(c))
    )
    return c.body(null, 204)
  })

  app.delete(finding, async (c) => {
    await reviewer.discard(c.req.param("itemID"))
    return c.body(null, 204)
  })

  app.get(`${finding}/capture`, async (c) => {
    const png = await reviewer.capturePNG(c.req.param("itemID"))
    return imageResponse(png, "image/png")
  })

  // Design Snapshots arrive as the raw image; a designer's export stays far
  // below this, and the server holds one in memory to check it.
  const imageBody = bodyLimit({
    maxSize: 50 * 1024 * 1024,
    onError: () => {
      throw new HTTPException(413, {
        message: "That image is larger than 50 MB.",
      })
    },
  })

  // Not a run: sending Feedback never freezes the review behind the dialog.
  app.post("/api/feedback", imageBody, async (c) => {
    if (youTrack === undefined) {
      return notConnected(c, "send Feedback")
    }
    const form = await c.req.parseBody()
    const request = parseFeedbackRequest(form.feedback)
    const image =
      form.image instanceof File
        ? await feedbackImagePNG(new Uint8Array(await form.image.arrayBuffer()))
        : undefined
    const sent = await sendFeedback(
      { ...request, imagePNG: image },
      { youTrack, flatten: annotatedScreenshotPNG }
    )
    return c.json({ sent } satisfies FeedbackResponse)
  })

  app.post(`${finding}/design-snapshots`, imageBody, async (c) => {
    const snapshot = await reviewer.addDesignSnapshot(
      c.req.param("itemID"),
      c.req.query("name") ?? "",
      new Uint8Array(await c.req.arrayBuffer())
    )
    return c.json({ snapshot } satisfies DesignSnapshotResponse)
  })

  app.put(`${finding}/design-snapshots/:snapshotID`, imageBody, async (c) => {
    const snapshot = await reviewer.replaceDesignSnapshot(
      c.req.param("itemID"),
      c.req.param("snapshotID"),
      c.req.query("name") ?? "",
      new Uint8Array(await c.req.arrayBuffer())
    )
    return c.json({ snapshot } satisfies DesignSnapshotResponse)
  })

  app.patch(`${finding}/design-snapshots/:snapshotID`, async (c) => {
    const name = (await jsonBody(c)).name
    if (typeof name !== "string") throw malformedRequest()
    const snapshot = await reviewer.renameDesignSnapshot(
      c.req.param("itemID"),
      c.req.param("snapshotID"),
      name
    )
    return c.json({ snapshot } satisfies DesignSnapshotResponse)
  })

  app.delete(`${finding}/design-snapshots/:snapshotID`, async (c) => {
    await reviewer.removeDesignSnapshot(
      c.req.param("itemID"),
      c.req.param("snapshotID")
    )
    return c.body(null, 204)
  })

  app.get(`${finding}/design-snapshot-data/:dataVersion`, async (c) => {
    const { snapshot, data } = await reviewer.designSnapshotData(
      c.req.param("itemID"),
      c.req.param("dataVersion")
    )
    return imageResponse(data, designSnapshotContentType(snapshot.mediaType))
  })

  // A label's glyphs for the Editor's preview, by the rasterizer that
  // flattens (core's labelSpriteLayout places them). The same query always
  // gives the same image.
  app.get("/api/label-sprite", async (c) => {
    const text = c.req.query("text") ?? ""
    const fontSize = Number(c.req.query("size"))
    const offset = Number(c.req.query("offset"))
    const color = annotationColors.find((name) => name === c.req.query("color"))
    if (
      text === "" ||
      text.length > 1000 ||
      !Number.isInteger(fontSize) ||
      fontSize < 1 ||
      fontSize > 1000 ||
      !(offset >= 0 && offset < 1) ||
      color === undefined
    ) {
      throw malformedRequest()
    }
    return imageResponse(
      await labelSpritePNG({ text, color, fontSize, offset }),
      "image/png"
    )
  })

  app.onError((error, c) => {
    const status = errorStatus(error)
    if (status === 500) console.error(error)
    const message =
      error instanceof Error && error.message !== ""
        ? error.message
        : "The nitpick server failed to answer."
    return c.json(
      {
        error: message,
        ...(error instanceof DeviceNotRunning && {
          code: "deviceNotRunning" as const,
        }),
      } satisfies ErrorResponse,
      status
    )
  })

  if (webRoot !== undefined) {
    app.use("/*", serveStatic({ root: webRoot }))
  }

  return app
}

/** Refusals the Reviewer can act on keep their message; the rest are 500s. */
function errorStatus(error: unknown): ContentfulStatusCode {
  if (error instanceof HTTPException) {
    return error.status === 413 ? 413 : 400
  }
  if (
    error instanceof BuildIngestError ||
    error instanceof DesignSnapshotError ||
    error instanceof MalformedEdit ||
    error instanceof MalformedFeedback
  ) {
    return 400
  }
  if (error instanceof FindingNotFound) return 404
  if (
    error instanceof ShellBusy ||
    error instanceof ReviewRefused ||
    error instanceof RuntimeUnavailable ||
    error instanceof DeviceNotRunning
  ) {
    return 409
  }
  if (error instanceof YouTrackError) return 502
  return 500
}

function notConnected(c: Context, action: string): Response {
  return c.json(
    {
      error: `The nitpick server has no YouTrack connection configured, so it can't ${action}.`,
    } satisfies ErrorResponse,
    503
  )
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
    designReference: session.designReference,
    tray: session.tray,
  }
}

/**
 * The bytes under a capture's item id, a Design Snapshot's dataVersion or a
 * label sprite's query never change, so the browser may keep them.
 */
function imageResponse(data: Uint8Array, contentType: string): Response {
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  })
}

function readyHost(
  devices: ReadonlyArray<SimulatorDevice>,
  recentDevices: RecentDevices
): ReadyHost {
  return { status: "ready", devices, recentDeviceUDIDs: recentDevices.udids }
}
