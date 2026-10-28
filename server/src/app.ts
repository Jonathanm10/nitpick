import { serveStatic } from "@hono/node-server/serve-static"
import {
  annotationColors,
  buildPlatform,
  designSnapshotContentType,
  historyFiledBy,
  DesignSnapshotError,
  sendFeedback,
  ShellBusy,
  verifyYouTrack,
  YouTrackError,
  type Build,
  type RecentDevices,
  type ReviewSession,
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
  DeviceStreamResponse,
  ErrorResponse,
  FeedbackEnvironmentResponse,
  FeedbackResponse,
  FilingResponse,
  HistoryImportResponse,
  HistoryResponse,
  HostResponse,
  ProjectsResponse,
  SignedInResponse,
  SignInMethodResponse,
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
import type {
  AndroidProblem,
  DeviceHost,
  SimulatorDevice,
} from "./device/DeviceHost.ts"
import { DeviceHostFull, DeviceInUse } from "./device/deviceClaims.ts"
import {
  DeviceStreamUnavailable,
  type DeviceStream,
} from "./device/deviceHub.ts"
import {
  deviceHubRoutePrefix,
  isSameOrigin,
  proxyHubHTTP,
  refusal,
  routeHubRequest,
} from "./device/deviceHubProxy.ts"
import { EmulatorBootTimedOut, NoLauncherActivity } from "./device/android.ts"
import {
  AndroidUnavailable,
  androidProblemReason,
  hostProblemReason,
} from "./device/hostHealth.ts"
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
import { FindingNotFound, ReviewRefused } from "./reviewer.ts"
import {
  hubCallbackPath,
  hubSignInCookie,
  hubSignInOf,
  rejectedMessage,
  SignInFailed,
  signInCookie,
  signedOutCookie,
  type Reviewers,
  type SignedIn,
} from "./reviewers.ts"
import { HubRefused } from "./youTrackHub.ts"

export interface AppOptions {
  readonly deviceHost: DeviceHost
  /** Who is signed in; each request acts for the Reviewer its cookie names. */
  readonly reviewers: Reviewers
  /** Every Reviewer's History, of which each reads their own. */
  readonly history: HistoryStore
  /** This server's version, for a Feedback's Environment. */
  readonly serverVersion: string
  /** The built web app. Omitted in development, where Vite serves it. */
  readonly webRoot?: string
  /** The hub that streams the devices; omitted where nothing streams. */
  readonly deviceStream?: DeviceStream
}

type SignedInEnvironment = {
  Variables: { signedIn: SignedIn | undefined }
}

export function createApp({
  deviceHost,
  reviewers,
  history,
  serverVersion,
  webRoot,
  deviceStream,
}: AppOptions): Hono<SignedInEnvironment> {
  const app = new Hono<SignedInEnvironment>()

  // The only way to the hub: allowlisted, signed in, each route with the
  // one method the viewer uses. It checks the sign-in itself, after the
  // allowlist, so any other route is a 404.
  app.all(`${deviceHubRoutePrefix}/*`, (c) => {
    const route = routeHubRequest(
      {
        method: c.req.method,
        url: c.req.url,
        isUpgrade: false,
        header: (name) => c.req.header(name),
      },
      (header) => reviewers.admit(header),
      deviceStream
    )
    return "status" in route ? refusal(route) : proxyHubHTTP(c.req.raw, route)
  })

  // The sign-in cookie is SameSite=Lax, which a page on another origin of
  // the same site, another port of the host, still gets. So whatever
  // changes state must come from nitpick's own page.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method
    if (
      method !== "GET" &&
      method !== "HEAD" &&
      !isSameOrigin((name) => c.req.header(name))
    ) {
      return c.json(
        {
          error: "Only nitpick's own page can do that.",
        } satisfies ErrorResponse,
        403
      )
    }
    await next()
  })

  // The token travels once, in this body; the page only ever gets the cookie.
  app.post("/api/sign-in", async (c) => {
    const token = (await jsonBody(c)).token
    if (typeof token !== "string") throw malformedRequest()
    const { id, signedIn } = await reviewers.signIn(token)
    // A sign-in this browser still held is replaced, not left behind.
    const previous = reviewers.authenticate(c.req.header("cookie"))
    if (previous.status === "signedIn") {
      await reviewers.signOut(previous.signedIn)
    }
    c.header("Set-Cookie", signInCookie(id, isSecure(c)))
    return c.json({ reviewer: signedIn.user } satisfies SignedInResponse)
  })

  app.post("/api/sign-out", async (c) => {
    const current = reviewers.authenticate(c.req.header("cookie"))
    if (current.status === "signedIn") {
      await reviewers.signOut(current.signedIn)
    }
    c.header("Set-Cookie", signedOutCookie(isSecure(c)))
    return c.body(null, 204)
  })

  // How the page signs a Reviewer in: through YouTrack's login when nitpick
  // is registered with YouTrack's Hub, otherwise with a permanent token.
  app.get("/api/sign-in", (c) =>
    c.json({
      method: reviewers.signInThroughHub ? "youTrack" : "token",
    } satisfies SignInMethodResponse)
  )

  // Off to YouTrack's login. The state and PKCE verifier stay in a cookie
  // only the way back reads, so a code sent back to another browser, or to
  // this one after it started another sign-in, signs no one in.
  app.get("/api/sign-in/youtrack", (c) => {
    const start = reviewers.startHubSignIn(hubCallbackURL(c))
    c.header("Set-Cookie", hubSignInCookie(start, isSecure(c)))
    return c.redirect(start.url, 302)
  })

  // Back from YouTrack. What went wrong reaches the page as a code, so no
  // other site can put words on nitpick's sign-in.
  app.get(hubCallbackPath, async (c) => {
    const started = hubSignInOf(c.req.header("cookie"))
    c.header("Set-Cookie", hubSignInCookie(undefined, isSecure(c)))
    const code = c.req.query("code")
    if (started === undefined || c.req.query("state") !== started.state) {
      return c.redirect("/?sign-in=expired", 302)
    }
    if (c.req.query("error") === "access_denied") {
      return c.redirect("/?sign-in=denied", 302)
    }
    if (code === undefined) return c.redirect("/?sign-in=failed", 302)
    try {
      const { id } = await reviewers.finishHubSignIn(
        code,
        hubCallbackURL(c),
        started.verifier
      )
      // A sign-in this browser still held is replaced, not left behind.
      const previous = reviewers.authenticate(c.req.header("cookie"))
      if (previous.status === "signedIn") {
        await reviewers.signOut(previous.signedIn)
      }
      c.header("Set-Cookie", signInCookie(id, isSecure(c)), { append: true })
      return c.redirect("/", 302)
    } catch (error) {
      // Mostly nitpick's registration with Hub, for the host's operator.
      console.error(
        `Signing in through YouTrack failed: ${error instanceof Error ? error.message : "unknown error"}`
      )
      return c.redirect("/?sign-in=failed", 302)
    }
  })

  // Every other route acts for a signed-in Reviewer, or answers 401.
  app.use("/api/*", async (c, next) => {
    const authentication = reviewers.authenticate(c.req.header("cookie"))
    if (authentication.status === "signedOut") {
      return signInNeeded(c, authentication.reason)
    }
    const { id, signedIn } = authentication
    if (await reviewers.renew(signedIn)) {
      c.header("Set-Cookie", signInCookie(id, isSecure(c)))
    }
    c.set("signedIn", signedIn)
    await next()
  })

  /** The request's Reviewer, whom the gate above let through. */
  const signedInTo = (c: Context<SignedInEnvironment>) => c.get("signedIn")!
  const reviewerOf = (c: Context<SignedInEnvironment>) => signedInTo(c).reviewer

  app.get("/api/me", (c) =>
    c.json({ reviewer: signedInTo(c).user } satisfies SignedInResponse)
  )

  app.get("/api/devices", async (c) => {
    const devices = await deviceHost.devices.list()
    return c.json({ devices } satisfies DevicesResponse)
  })

  app.get("/api/host", async (c) => {
    const status = await reviewerOf(c).hostStatus()
    return c.json(
      (status.status === "ready"
        ? readyHost(status)
        : {
            status: "notReady",
            reason: hostProblemReason(status.problem),
          }) satisfies HostResponse
    )
  })

  app.get("/api/projects", async (c) => {
    const { projects } = await verifyYouTrack(signedInTo(c).youTrack)
    return c.json({ projects } satisfies ProjectsResponse)
  })

  app.get("/api/review", async (c) => {
    const { build, session, filing } = await reviewerOf(c).state()
    return c.json({
      build: build && buildSummary(build),
      session: session && sessionSummary(session),
      filing,
    } satisfies ReviewStateResponse)
  })

  // File all runs on the server: the answer comes at once, and the page
  // follows the run through /api/review.
  app.post("/api/session/filing", (c) => {
    const signedIn = signedInTo(c)
    void reviewers.fileAll(signedIn)
    return c.json(
      { filing: signedIn.reviewer.filingStatus() } satisfies FilingResponse,
      202
    )
  })

  app.delete("/api/filing-result", (c) => {
    reviewerOf(c).dismissFilingResult()
    return c.body(null, 204)
  })

  app.get("/api/history", async (c) => {
    const reviewer = signedInTo(c).user
    return c.json({
      entries: historyFiledBy(await history.entries(), reviewer),
      reviewer,
    } satisfies HistoryResponse)
  })

  // The Swift app's History files, or a zip of its history folder. A
  // designer's whole History is a few megabytes at most.
  app.post(
    "/api/history/import",
    bodyLimit({
      maxSize: 50 * 1024 * 1024,
      onError: () => {
        throw new HTTPException(413, {
          message: "That import is larger than 50 MB.",
        })
      },
    }),
    async (c) => {
      const chosen = (await c.req.parseBody({ all: true })).files
      const files = Array.isArray(chosen) ? chosen : [chosen]
      if (!files.every((file) => file instanceof File) || files.length === 0) {
        throw malformedRequest()
      }
      const results = await reviewerOf(c).importHistory(
        await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
          }))
        ),
        signedInTo(c).user
      )
      return c.json({ results } satisfies HistoryImportResponse)
    }
  )

  app.get("/api/feedback/environment", async (c) =>
    c.json({
      server: serverVersion,
      deviceHost: await deviceHost.versions(),
    } satisfies FeedbackEnvironmentResponse)
  )

  app.post("/api/build", async (c) => {
    const build = await reviewerOf(c).ingest(
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
    const outcome = await reviewerOf(c).start(
      { deviceUDID: deviceUDID(body), projectID },
      signedInTo(c)
    )
    return c.json(
      (outcome.status === "started"
        ? {
            status: "started",
            session: sessionSummary(outcome.session),
            device: outcome.device,
            schema: outcome.schema,
            host: readyHost(outcome),
          }
        : {
            status: "notReady",
            reason: hostProblemReason(outcome.problem),
          }) satisfies StartReviewResponse
    )
  })

  app.put("/api/session/device", async (c) => {
    const { device, recentDevices } = await reviewerOf(c).switchDevice(
      deviceUDID(await jsonBody(c)),
      signedInTo(c).user
    )
    return c.json({
      device,
      recentDeviceUDIDs: recentDevices.udids,
    } satisfies SwitchDeviceResponse)
  })

  app.delete("/api/session", async (c) => {
    await reviewerOf(c).end()
    return c.body(null, 204)
  })

  app.patch("/api/session", async (c) => {
    await reviewerOf(c).editSession(parseSessionPatch(await jsonBody(c)))
    return c.body(null, 204)
  })

  app.post("/api/session/captures", async (c) => {
    const item = await reviewerOf(c).capture(deviceUDID(await jsonBody(c)))
    return c.json({ item } satisfies CaptureResponse)
  })

  const finding = "/api/session/findings/:itemID"

  app.patch(finding, async (c) => {
    await reviewerOf(c).editFinding(
      c.req.param("itemID"),
      parseFindingPatch(await jsonBody(c))
    )
    return c.body(null, 204)
  })

  app.delete(finding, async (c) => {
    await reviewerOf(c).discard(c.req.param("itemID"))
    return c.body(null, 204)
  })

  app.get(`${finding}/capture`, async (c) => {
    const png = await reviewerOf(c).capturePNG(c.req.param("itemID"))
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
    const form = await c.req.parseBody()
    const request = parseFeedbackRequest(form.feedback)
    const image =
      form.image instanceof File
        ? await feedbackImagePNG(new Uint8Array(await form.image.arrayBuffer()))
        : undefined
    const sent = await sendFeedback(
      { ...request, imagePNG: image },
      { youTrack: signedInTo(c).youTrack, flatten: annotatedScreenshotPNG }
    )
    return c.json({ sent } satisfies FeedbackResponse)
  })

  app.post(`${finding}/design-snapshots`, imageBody, async (c) => {
    const snapshot = await reviewerOf(c).addDesignSnapshot(
      c.req.param("itemID"),
      c.req.query("name") ?? "",
      new Uint8Array(await c.req.arrayBuffer())
    )
    return c.json({ snapshot } satisfies DesignSnapshotResponse)
  })

  app.put(`${finding}/design-snapshots/:snapshotID`, imageBody, async (c) => {
    const snapshot = await reviewerOf(c).replaceDesignSnapshot(
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
    const snapshot = await reviewerOf(c).renameDesignSnapshot(
      c.req.param("itemID"),
      c.req.param("snapshotID"),
      name
    )
    return c.json({ snapshot } satisfies DesignSnapshotResponse)
  })

  app.delete(`${finding}/design-snapshots/:snapshotID`, async (c) => {
    await reviewerOf(c).removeDesignSnapshot(
      c.req.param("itemID"),
      c.req.param("snapshotID")
    )
    return c.body(null, 204)
  })

  app.get(`${finding}/design-snapshot-data/:dataVersion`, async (c) => {
    const { snapshot, data } = await reviewerOf(c).designSnapshotData(
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

  // Starts streaming the device the Build runs on. The page then reads the
  // stream and opens the input socket through the proxy above, which an
  // <img>, a fetch and a WebSocket reach with the sign-in cookie. serve-emu
  // streams an emulator on the viewer's first request, by its serial.
  app.post("/api/device-stream", async (c) => {
    if (deviceStream === undefined) return streamOff(c)
    const udid = deviceUDID(await jsonBody(c))
    const device = (await deviceHost.devices.list()).find(
      (candidate) => candidate.udid === udid
    )
    if (device?.isBooted !== true) {
      throw new DeviceNotRunning(
        device?.name ?? "The device",
        "it can't be shown"
      )
    }
    if (device.serial !== undefined) {
      return c.json({ hubDevice: device.serial } satisfies DeviceStreamResponse)
    }
    await deviceStream.attach(udid)
    return c.json({ hubDevice: udid } satisfies DeviceStreamResponse)
  })

  app.onError(async (error, c) => {
    // A token YouTrack stopped taking ends its sign-in, and the page signs
    // in again; the open session stays on the server.
    const signedIn = c.get("signedIn")
    if (
      signedIn !== undefined &&
      error instanceof YouTrackError &&
      error.failure.kind === "tokenRejected"
    ) {
      await reviewers.endRejected(signedIn.signIn)
      return signInNeeded(c, rejectedMessage(signedIn.signIn))
    }
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
  if (error instanceof SignInFailed) return error.status
  if (error instanceof FindingNotFound) return 404
  if (
    error instanceof ShellBusy ||
    error instanceof ReviewRefused ||
    error instanceof RuntimeUnavailable ||
    error instanceof DeviceNotRunning ||
    error instanceof AndroidUnavailable ||
    error instanceof NoLauncherActivity ||
    error instanceof DeviceInUse ||
    error instanceof DeviceHostFull
  ) {
    return 409
  }
  if (error instanceof EmulatorBootTimedOut) return 504
  if (error instanceof YouTrackError || error instanceof HubRefused) return 502
  if (error instanceof DeviceStreamUnavailable) return 503
  return 500
}

function streamOff(c: Context): Response {
  return c.json(
    {
      error: "The Device Host isn't streaming devices.",
    } satisfies ErrorResponse,
    503
  )
}

/** 401: the page shows sign-in, with the reason when the sign-in ended itself. */
function signInNeeded(c: Context, reason: string | undefined): Response {
  c.header("Set-Cookie", signedOutCookie(isSecure(c)))
  return c.json(
    {
      error: reason ?? "Sign in to continue.",
      code: "signIn",
    } satisfies ErrorResponse,
    401
  )
}

function isSecure(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:"
}

/** Where Hub sends the browser back: this server, as the browser reached it. */
function hubCallbackURL(c: Context): string {
  return `${new URL(c.req.url).origin}${hubCallbackPath}`
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
  return {
    name: buildName(build),
    identity: build.identity,
    platform: buildPlatform(build),
  }
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

function readyHost({
  devices,
  recentDevices,
  androidProblem,
}: {
  readonly devices: ReadonlyArray<SimulatorDevice>
  readonly recentDevices: RecentDevices
  readonly androidProblem?: AndroidProblem
}): ReadyHost {
  return {
    status: "ready",
    devices,
    recentDeviceUDIDs: recentDevices.udids,
    ...(androidProblem !== undefined && {
      androidProblem: androidProblemReason(androidProblem),
    }),
  }
}
