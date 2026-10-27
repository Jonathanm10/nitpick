// Ports the halves of three Swift cases that need real flattening:
// IssueFilingTests.attachesAnnotatedAndOriginal and
// .flatteningFailureLeavesNoOrphan, and FeedbackSendingTests
// .uploadsAnnotatedImage. Core's ladder and Feedback run with the server's
// Skia flattener, and the images they upload are decoded.
import {
  addFinding,
  fileAll,
  newFinding,
  newReviewSession,
  sendFeedback,
  YouTrackClient,
  YouTrackCredentials,
  type Annotation,
  type FilingStore,
  type HTTPRequest,
} from "@nitpick/core"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { FakeHTTPTransport } from "../../core/test/FakeHTTPTransport.ts"
import {
  annotatedScreenshotPNG,
  UnreadableScreenshot,
} from "../src/annotationFlattening.ts"
import { decodeRGBA } from "./ImageFixtures.ts"

const capture = readFileSync(
  new URL("../../core/test/golden/images/capture.png", import.meta.url)
)

const youTrack = (transport: FakeHTTPTransport) =>
  new YouTrackClient(
    transport,
    new YouTrackCredentials("https://youtrack.example.com/yt", "perm:t")
  )

const rectangle: Annotation = {
  kind: "rectangle",
  color: "red",
  rect: { x: 60, y: 500, width: 240, height: 160 },
}

/** Keeps the capture in memory and records nothing: filing is what's tested. */
function store(png: Uint8Array): FilingStore {
  return {
    saveOpenSession: async () => {},
    recordInHistory: async () => {},
    capturePNG: async () => png,
    designSnapshotData: async () => new Uint8Array(),
  }
}

/** The parts of a multipart body, split on its boundary. */
function uploads(request: HTTPRequest | undefined): Buffer[] {
  const boundary = /boundary=(.+)$/.exec(
    request?.headers["Content-Type"] ?? ""
  )?.[1]
  if (request?.body === undefined || boundary === undefined) {
    throw new Error("not a multipart request")
  }
  const body = Buffer.from(request.body)
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: Buffer[] = []
  let start = body.indexOf(delimiter) + delimiter.length
  for (;;) {
    const end = body.indexOf(delimiter, start)
    if (end === -1) break
    const part = body.subarray(start, end - 2) // the CRLF before the delimiter
    parts.push(part.subarray(part.indexOf("\r\n\r\n") + 4))
    start = end + delimiter.length
  }
  return parts
}

const session = newReviewSession({
  build: {
    identity: {
      bundleID: "ch.liip.reviewme",
      version: "2.1.0",
      buildNumber: "421",
    },
    appBundleURL: "file:///tmp/ReviewMe.app/",
  },
  project: { id: "0-12", shortName: "RM", name: "Review Me" },
  startedAt: 804849332,
})

function annotatedSession(annotations: Annotation[]) {
  return addFinding(session, {
    ...newFinding({
      summary: "Button color is off",
      description: "",
      deviceContext: {
        deviceModel: "iPhone 17 Pro",
        osName: "iOS 26.4",
        accessibilitySettings: [],
      },
    }),
    annotations,
  }).session
}

describe("Filing with the server's flattener", () => {
  test("an annotated Finding attaches the flattened variant plus the untouched original", async () => {
    const transport = new FakeHTTPTransport()
    for (const json of [
      `[{"id":"6-4","name":"design-review"}]`,
      `[{"id":"6-5","name":"nitpick-type:bug"}]`,
      `{"id":"3-505","idReadable":"RM-421"}`,
      `[{"id":"134-31","name":"annotated.png"},{"id":"134-32","name":"original.png"}]`,
      `{"id":"6-4","name":"design-review"}`,
      `{"id":"6-5","name":"nitpick-type:bug"}`,
    ]) {
      transport.enqueue(json)
    }

    const outcome = await fileAll(annotatedSession([rectangle]), {
      youTrack: youTrack(transport),
      store: store(capture),
      flatten: annotatedScreenshotPNG,
    })

    expect(outcome.failure).toBeUndefined()
    const [annotated, original] = uploads(transport.sentRequests[3])
    expect(Buffer.compare(original, capture)).toBe(0)
    expect(Buffer.compare(annotated, capture)).not.toBe(0)
    expect(
      Buffer.compare(
        annotated,
        await annotatedScreenshotPNG(capture, [rectangle])
      )
    ).toBe(0)
    const decoded = await decodeRGBA(annotated)
    expect([decoded.width, decoded.height]).toEqual([480, 960])
  })

  test("a flattening failure aborts before any issue exists — no orphans", async () => {
    const transport = new FakeHTTPTransport()
    const notAnImage = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
    ])

    const outcome = await fileAll(
      annotatedSession([
        {
          kind: "rectangle",
          color: "red",
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
      ]),
      {
        youTrack: youTrack(transport),
        store: store(notAnImage),
        flatten: annotatedScreenshotPNG,
      }
    )

    expect(outcome.failure).toBeInstanceOf(UnreadableScreenshot)
    expect(transport.sentRequests).toEqual([])
  })

  test("Annotations on the window image are flattened into the uploaded PNG at its native size", async () => {
    const transport = new FakeHTTPTransport()
    for (const json of [
      `{"id":"0-77","name":"Nitpick"}`,
      `[{"id":"6-3910","name":"nitpick-feedback:bug"}]`,
      `{"id":"3-900","idReadable":"NIT-42"}`,
      `{"id":"6-3910","name":"nitpick-feedback:bug"}`,
      `[{"id":"134-90","name":"nitpick-window.png"}]`,
    ]) {
      transport.enqueue(json)
    }
    const annotations: Annotation[] = [
      {
        kind: "rectangle",
        color: "red",
        rect: { x: 40, y: 40, width: 200, height: 120 },
      },
    ]

    const sent = await sendFeedback(
      {
        kind: "bug",
        title: "Tray loses focus after capture",
        description: "",
        environment: { nitpick: "unknown", macOS: "26.1", xcode: "unknown" },
        imagePNG: capture,
        imageAnnotations: annotations,
      },
      { youTrack: youTrack(transport), flatten: annotatedScreenshotPNG }
    )

    expect(sent.warnings).toEqual([])
    const [image] = uploads(transport.sentRequests.at(-1))
    expect(Buffer.compare(image, capture)).not.toBe(0)
    expect(
      Buffer.compare(image, await annotatedScreenshotPNG(capture, annotations))
    ).toBe(0)
    const decoded = await decodeRGBA(image)
    expect([decoded.width, decoded.height]).toEqual([480, 960])
  })
})
