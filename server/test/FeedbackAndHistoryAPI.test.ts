// Feedback about nitpick, the shared History and the Environment the server
// reads, in process against the route-answering fake YouTrack. Not ports:
// FeedbackSending.test.ts ports Swift's Feedback cases on core's
// sendFeedback, and these pin the page's routes around it.
import { copyFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createCanvas } from "@napi-rs/canvas"
import { feedbackDescription, webFeedbackEnvironment } from "@nitpick/core"
import { describe, expect, test } from "vitest"
import {
  goldenInput,
  historyEntryFrom,
  type DescribedHistoryEntry,
} from "../../core/test/golden.ts"
import type {
  FeedbackEnvironmentResponse,
  FeedbackRequest,
  FeedbackResponse,
  HistoryResponse,
} from "../src/api.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeYouTrack } from "./FakeYouTrack.ts"
import { signedInApp, vera } from "./SignedIn.ts"
import { decodeRGBA } from "./ImageFixtures.ts"

function harness() {
  const data = temporaryDirectory()
  const fake = new FakeYouTrack()
  const deviceHost = new FakeDeviceHost([])
  const { app, history } = signedInApp({
    data,
    deviceHost,
    transport: fake.transport,
    instanceURL: fake.instanceURL,
    serverVersion: "0.0.0 (3b9ef47)",
  })
  return { app, fake, deviceHost, history, data }
}

const environment = webFeedbackEnvironment({
  webApp: "0.0.1 (3b9ef47)",
  server: "0.0.0 (3b9ef47)",
  browser: "Chrome 131 on macOS",
  deviceHostMacOS: "Version 26.1 (Build 25B78)",
  deviceHostXcode: "26.1 (17B55)",
})

const request: FeedbackRequest = {
  kind: "improvement",
  title: "Let History filter by project",
  description: "With five projects the list gets long.",
  environment,
}

function send(
  { app }: ReturnType<typeof harness>,
  feedback: unknown,
  image?: { readonly bytes: Uint8Array; readonly type: string }
) {
  const form = new FormData()
  form.set("feedback", JSON.stringify(feedback))
  if (image !== undefined) {
    form.set(
      "image",
      new File([Buffer.from(image.bytes)], "pasted.png", { type: image.type })
    )
  }
  return app.request("/api/feedback", { method: "POST", body: form })
}

const png = new Uint8Array(createCanvas(40, 30).encodeSync("png"))
const jpeg = new Uint8Array(createCanvas(40, 30).encodeSync("jpeg"))

describe("Send feedback", () => {
  test("files one Issue in NIT with the Environment the dialog showed, tagged by kind", async () => {
    const h = harness()

    const response = await send(h, request)

    expect(response.status).toBe(200)
    const [issue] = h.fake.issues
    expect(await response.json()).toEqual({
      sent: {
        idReadable: "NIT-101",
        url: `${h.fake.instanceURL}/issue/NIT-101`,
        warnings: [],
      },
    } satisfies FeedbackResponse)
    expect(issue.projectID).toBe("0-99")
    expect(issue.summary).toBe("Let History filter by project")
    expect(issue.description).toBe(
      feedbackDescription({ ...request, environment })
    )
    expect(issue.tags).toEqual(["nitpick-feedback:improvement"])
    expect(issue.attachments).toEqual([])
  })

  test("an attached image carries its Annotations, drawn in at its own size", async () => {
    const h = harness()

    const response = await send(
      h,
      {
        ...request,
        imageAnnotations: [
          {
            kind: "rectangle",
            color: "red",
            rect: { x: 4, y: 4, width: 20, height: 12 },
          },
        ],
      },
      { bytes: png, type: "image/png" }
    )

    expect(((await response.json()) as FeedbackResponse).sent.warnings).toEqual(
      []
    )
    const [attachment] = h.fake.issues[0].attachments
    expect(attachment.fileName).toBe("nitpick-window.png")
    const sent = await decodeRGBA(attachment.data)
    const clean = await decodeRGBA(png)
    expect([sent.width, sent.height]).toEqual([40, 30])
    expect(Buffer.from(sent.pixels).equals(Buffer.from(clean.pixels))).toBe(
      false
    )
  })

  test("a JPEG is attached as a PNG; a PNG without Annotations as it came", async () => {
    const jpegSent = harness()
    await send(jpegSent, request, { bytes: jpeg, type: "image/jpeg" })
    const pngSent = harness()
    await send(pngSent, request, { bytes: png, type: "image/png" })

    const reencoded = jpegSent.fake.issues[0].attachments[0].data
    expect(reencoded.subarray(1, 4).toString("latin1")).toBe("PNG")
    expect((await decodeRGBA(reencoded)).width).toBe(40)
    expect(pngSent.fake.issues[0].attachments[0].data.equals(png)).toBe(true)
  })

  test("YouTrack's refusal comes back in the Reviewer's words, and nothing is filed", async () => {
    const h = harness()
    h.fake.intercept = (recorded) =>
      recorded.path === "api/issues" ? { status: 403 } : undefined

    const response = await send(h, request)

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error:
        "YouTrack denied permission to create an issue in nitpick. Ask a YouTrack administrator about your access.",
    })
    expect(h.fake.issues).toEqual([])
  })

  test("a malformed Feedback or an unreadable image is refused before YouTrack", async () => {
    const h = harness()

    const unknownKind = await send(h, { ...request, kind: "praise" })
    const unknownLine = await send(h, {
      ...request,
      environment: { ...environment, homeDirectory: "/Users/someone" },
    })
    const notAnImage = await send(h, request, {
      bytes: new Uint8Array([1, 2, 3]),
      type: "image/png",
    })

    expect(
      await Promise.all(
        [unknownKind, unknownLine, notAnImage].map(async (response) => [
          response.status,
          ((await response.json()) as { error: string }).error,
        ])
      )
    ).toEqual([
      [400, "The Feedback can't be sent: its kind is unknown."],
      [
        400,
        "The Feedback can't be sent: environment.homeDirectory is not an Environment line.",
      ],
      [
        400,
        "The Feedback can't be sent: the image can't be read. Attach a PNG or JPEG.",
      ],
    ])
    expect(h.fake.requests).toEqual([])
  })

  test("the server's own Environment lines: its version and the Device Host's", async () => {
    const h = harness()

    const response = await h.app.request("/api/feedback/environment")

    expect(await response.json()).toEqual({
      server: "0.0.0 (3b9ef47)",
      deviceHost: {
        macOS: "Version 26.1 (Build 25B78)",
        xcode: "26.1 (17B55)",
      },
    } satisfies FeedbackEnvironmentResponse)
  })
})

describe("The History page's data", () => {
  test("an entry the Swift app wrote decodes from the golden, filer unknown", async () => {
    const h = harness()
    mkdirSync(h.history.directory, { recursive: true })
    copyFileSync(
      new URL(
        "../../core/test/golden/stored-history-entry/history-entry.json",
        import.meta.url
      ),
      join(h.history.directory, "2026-07-04T09-15-32.473Z.json")
    )

    const body = (await (
      await h.app.request("/api/history")
    ).json()) as HistoryResponse

    expect(body).toEqual({
      entries: [
        historyEntryFrom(
          goldenInput<{ historyEntry: DescribedHistoryEntry }>(
            "stored-history-entry/history-entry.input.json"
          ).historyEntry
        ),
      ],
      reviewer: { login: "vera", fullName: "Vera Baumann" },
    })
  })

  test("lists newest session first, and stays readable without YouTrack, naming who asks", async () => {
    const h = harness()
    h.fake.intercept = () => ({ status: 503 })
    const entry = historyEntryFrom(
      goldenInput<{ historyEntry: DescribedHistoryEntry }>(
        "stored-history-entry/history-entry.input.json"
      ).historyEntry
    )
    await h.history.record({ ...entry, startedAt: 100 })
    await h.history.record({ ...entry, startedAt: 300 })
    await h.history.record({ ...entry, startedAt: 200 })

    const body = (await (
      await h.app.request("/api/history")
    ).json()) as HistoryResponse

    expect(body.entries.map((e) => e.startedAt)).toEqual([300, 200, 100])
    expect(body.reviewer).toEqual(vera)
  })

  test("an empty History is an empty list", async () => {
    const body = (await (
      await harness().app.request("/api/history")
    ).json()) as HistoryResponse

    expect(body.entries).toEqual([])
  })

  test("recording a session again replaces its entry", async () => {
    const h = harness()
    const entry = historyEntryFrom(
      goldenInput<{ historyEntry: DescribedHistoryEntry }>(
        "stored-history-entry/history-entry.input.json"
      ).historyEntry
    )
    const filedBy = { login: "vera", fullName: "Vera Baumann" }
    await h.history.record({ ...entry, filedBy, findings: [] })
    await h.history.record({ ...entry, filedBy })

    expect(await h.history.entries()).toEqual([{ ...entry, filedBy }])
  })
})
