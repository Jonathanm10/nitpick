// Capture, the Editor's edits, discard and Design Snapshots through the API,
// as Sources/Nitpick/AppModel.swift's captureScreen, editSelectedFinding,
// discardFinding and the Design Snapshot operations drive them. Not a port:
// the Swift shell had no tests of its own. The edits' Swift halves are in
// core/test (DesignSnapshotEditing, SessionTrayScenario); these pin the
// server's files, refusals and status codes. The Device Host is a fake.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { createCanvas } from "@napi-rs/canvas"
import {
  addFinding,
  decodeStoredSession,
  encodeStoredSession,
  newFinding,
  newReviewSession,
  type Annotation,
  type ReviewSession,
} from "@nitpick/core"
import { beforeEach, describe, expect, test } from "vitest"
import type {
  CaptureResponse,
  DesignSnapshotResponse,
  ReviewStateResponse,
} from "../src/api.ts"
import { createApp } from "../src/app.ts"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import { HistoryStore } from "../src/historyStore.ts"
import { Reviewer } from "../src/reviewer.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const iPhone: SimulatorDevice = {
  udid: "AAAA-1111",
  name: "iPhone 17 Pro",
  osName: "iOS 26.4",
  isBooted: true,
  isRuntimeAvailable: true,
}

const deviceContext = {
  deviceModel: "iPhone 17 Pro",
  osName: "iOS 26.4",
  accessibilitySettings: [],
}

const png = new Uint8Array(createCanvas(20, 20).encodeSync("png"))
const otherPNG = new Uint8Array(createCanvas(30, 30).encodeSync("png"))
const jpeg = new Uint8Array(createCanvas(24, 18).encodeSync("jpeg"))

function harness() {
  const reviewerDirectory = join(temporaryDirectory(), "reviewers", "interim")
  const deviceHost = new FakeDeviceHost([iPhone])
  const history = new HistoryStore(join(temporaryDirectory(), "history"))
  const reviewer = new Reviewer(reviewerDirectory, {
    deviceHost,
    runner: new FakeSubprocessRunner(),
    youTrack: undefined,
    history,
  })
  const app = createApp({
    deviceHost,
    reviewer,
    youTrack: undefined,
    history,
    serverVersion: "0.0.0",
  })
  return { app, deviceHost, reviewerDirectory }
}

type Harness = ReturnType<typeof harness>

/** An open session with one Finding per summary, as a reload finds it. */
function openSession(h: Harness, summaries: string[] = []): ReviewSession {
  let session = newReviewSession({
    build: {
      identity: {
        bundleID: "ch.liip.reviewme",
        version: "2.1.0",
        buildNumber: "421",
      },
      appBundleURL: "file:///tmp/ReviewMe.app/",
    },
    project: { id: "0-12", shortName: "RM", name: "Review Me" },
  })
  for (const summary of summaries) {
    session = addFinding(
      session,
      newFinding({ summary, description: "", deviceContext })
    ).session
  }
  saveSession(h, session)
  return session
}

function saveSession(h: Harness, session: ReviewSession) {
  mkdirSync(join(h.reviewerDirectory, "open-session"), { recursive: true })
  writeFileSync(
    join(h.reviewerDirectory, "open-session", "session.json"),
    encodeStoredSession(session)
  )
}

function stored(h: Harness): ReviewSession {
  return decodeStoredSession(
    readFileSync(
      join(h.reviewerDirectory, "open-session", "session.json"),
      "utf8"
    )
  )
}

function files(h: Harness, ...path: string[]): string[] {
  const directory = join(h.reviewerDirectory, "open-session", ...path)
  return existsSync(directory) ? readdirSync(directory).sort() : []
}

function send(h: Harness, method: string, path: string, body?: unknown) {
  return h.app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function capture(h: Harness, deviceUDID = iPhone.udid) {
  return send(h, "POST", "/api/session/captures", { deviceUDID })
}

function patchFinding(h: Harness, id: string, patch: unknown) {
  return send(h, "PATCH", `/api/session/findings/${id}`, patch)
}

function uploadSnapshot(
  h: Harness,
  id: string,
  name: string,
  data: Uint8Array,
  snapshotID?: string
) {
  const path = `/api/session/findings/${id}/design-snapshots`
  return h.app.request(
    `${snapshotID === undefined ? path : `${path}/${snapshotID}`}?name=${encodeURIComponent(name)}`,
    { method: snapshotID === undefined ? "POST" : "PUT", body: data }
  )
}

async function errorOf(response: Response) {
  const body = (await response.json()) as Record<string, unknown>
  return { status: response.status, ...body }
}

describe("Capture", () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  test("a capture lands last in the Tray, stamped with the device and its read-back settings, and its PNG is served", async () => {
    const session = openSession(h, ["Header clips"])
    h.deviceHost.nextCapture = {
      png,
      settings: {
        dynamicTypeSize: "accessibility-large",
        appearance: "dark",
        increaseContrast: false,
      },
    }

    const response = await capture(h)

    expect(response.status).toBe(200)
    const { item } = (await response.json()) as CaptureResponse
    expect(item.finding).toEqual(
      newFinding({
        summary: "",
        description: "",
        deviceContext: {
          deviceModel: "iPhone 17 Pro",
          osName: "iOS 26.4",
          accessibilitySettings: ["Dynamic Type AX2", "Dark Mode"],
        },
      })
    )
    expect(stored(h).tray.map((stored) => stored.id)).toEqual([
      session.tray[0].id,
      item.id,
    ])
    expect(files(h, "captures")).toEqual([`${item.id}.png`])
    const served = await h.app.request(
      `/api/session/findings/${item.id}/capture`
    )
    expect(served.headers.get("Content-Type")).toBe("image/png")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)
  })

  test("a device that stopped refuses the capture with its own code, and nothing changes", async () => {
    openSession(h)
    h.deviceHost.health = {
      status: "ready",
      devices: [{ ...iPhone, isBooted: false }],
    }

    const response = await capture(h)

    expect(await errorOf(response)).toEqual({
      status: 409,
      code: "deviceNotRunning",
      error:
        "iPhone 17 Pro is no longer running on the Device Host, so nothing was captured. Resume review to relaunch the Build.",
    })
    expect(stored(h).tray).toEqual([])
  })

  test("without an open review there is nothing to capture into", async () => {
    expect(await errorOf(await capture(h))).toEqual({
      status: 409,
      error: "There is no open review.",
    })
  })

  test("an edit made while a capture runs is kept, and so is the capture", async () => {
    const [existing] = openSession(h, [""]).tray
    let finishCapture = () => {}
    h.deviceHost.captureDelay = new Promise((resolve) => {
      finishCapture = resolve
    })

    const capturing = capture(h)
    const edit = await patchFinding(h, existing.id, {
      summary: "Typed meanwhile",
    })
    finishCapture()
    const { item } = (await (await capturing).json()) as CaptureResponse

    expect(edit.status).toBe(204)
    expect(
      stored(h).tray.map((stored) => [stored.id, stored.finding.summary])
    ).toEqual([
      [existing.id, "Typed meanwhile"],
      [item.id, ""],
    ])
  })
})

describe("Editing a Finding", () => {
  let h: Harness
  let id: string

  beforeEach(() => {
    h = harness()
    id = openSession(h, ["Header clips"]).tray[0].id
  })

  test("an edit sets only the fields it names, so two tabs' edits to different fields both last", async () => {
    await patchFinding(h, id, { summary: "From the first tab" })
    await patchFinding(h, id, { description: "From the second tab" })

    expect(stored(h).tray[0].finding).toMatchObject({
      summary: "From the first tab",
      description: "From the second tab",
      type: "bug",
    })
  })

  test("triage fields set and clear, and a Design Reference is trimmed with blank as none", async () => {
    await patchFinding(h, id, {
      type: "improvement",
      priority: { name: "Critical" },
      assignee: { login: "vera", fullName: "Vera Baumann" },
      designReference: "  https://figma.example.com/file/1  ",
    })
    expect(stored(h).tray[0].finding).toMatchObject({
      type: "improvement",
      priority: { name: "Critical" },
      assignee: { login: "vera", fullName: "Vera Baumann" },
      designReference: "https://figma.example.com/file/1",
    })

    await patchFinding(h, id, {
      priority: null,
      assignee: null,
      designReference: " ",
    })
    const finding = stored(h).tray[0].finding
    expect(finding.priority).toBeUndefined()
    expect(finding.assignee).toBeUndefined()
    expect(finding.designReference).toBeUndefined()
  })

  test("Annotations are stored as sent, in stacking order", async () => {
    const annotations: Annotation[] = [
      {
        kind: "pen",
        color: "red",
        points: [
          { x: 1, y: 2 },
          { x: 3.5, y: 4 },
        ],
      },
      {
        kind: "arrow",
        color: "blue",
        from: { x: 0, y: 0 },
        to: { x: 9, y: 9 },
      },
      {
        kind: "rectangle",
        color: "yellow",
        rect: { x: 5, y: 6, width: -7, height: 8 },
      },
      { kind: "label", color: "white", text: "Too tight", at: { x: 1, y: 1 } },
    ]

    expect((await patchFinding(h, id, { annotations })).status).toBe(204)

    expect(stored(h).tray[0].finding.annotations).toEqual(annotations)
  })

  test("a malformed edit is refused and changes nothing", async () => {
    const before = stored(h)

    const responses = await Promise.all([
      patchFinding(h, id, {
        annotations: [{ kind: "circle", color: "red" }],
      }),
      patchFinding(h, id, {
        annotations: [
          { kind: "pen", color: "red", points: [{ x: "1", y: 2 }] },
        ],
      }),
      patchFinding(h, id, { type: "question" }),
      patchFinding(h, id, { filingProgress: { state: "filed" } }),
    ])

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ])
    expect(((await responses[3].json()) as { error: string }).error).toBe(
      "The edit is malformed: filingProgress is not an editable field."
    )
    expect(stored(h)).toEqual(before)
  })

  test("a Finding filing has touched is frozen, and one gone from the Tray is not found", async () => {
    const session = stored(h)
    saveSession(h, {
      ...session,
      tray: [
        {
          ...session.tray[0],
          filingProgress: {
            state: "issueCreated",
            issueID: "3-505",
            idReadable: "RM-421",
          },
        },
      ],
    })

    expect(
      await errorOf(await patchFinding(h, id, { summary: "Late" }))
    ).toEqual({
      status: 409,
      error: "This Finding has started filing, so it can no longer be edited.",
    })
    expect(
      await errorOf(
        await patchFinding(h, "00000000-0000-4000-8000-000000000000", {
          summary: "Gone",
        })
      )
    ).toEqual({ status: 404, error: "This Finding is no longer in the Tray." })
  })

  test("the session's Design Reference is set and cleared", async () => {
    await send(h, "PATCH", "/api/session", {
      designReference: "https://figma.example.com/file/2",
    })
    expect(stored(h).designReference).toBe("https://figma.example.com/file/2")

    await send(h, "PATCH", "/api/session", { designReference: null })
    expect(stored(h).designReference).toBeUndefined()
  })

  test("discard removes the Finding with its capture and Design Snapshots, and a second discard is no error", async () => {
    const captured = (await (await capture(h)).json()) as CaptureResponse
    await uploadSnapshot(h, captured.item.id, "spec.png", png)

    const first = await send(
      h,
      "DELETE",
      `/api/session/findings/${captured.item.id}`
    )
    const again = await send(
      h,
      "DELETE",
      `/api/session/findings/${captured.item.id}`
    )

    expect([first.status, again.status]).toEqual([204, 204])
    expect(stored(h).tray.map((item) => item.id)).toEqual([id])
    expect(files(h, "captures")).toEqual([])
    expect(files(h, "design-snapshots")).toEqual([])
  })

  test("edits need an open review", async () => {
    await send(h, "DELETE", "/api/session")

    expect(await errorOf(await patchFinding(h, id, { summary: "x" }))).toEqual({
      status: 409,
      error: "There is no open review.",
    })
  })
})

describe("Design Snapshots", () => {
  let h: Harness
  let id: string

  beforeEach(() => {
    h = harness()
    id = openSession(h, ["Header clips"]).tray[0].id
  })

  async function snapshotOf(response: Response) {
    expect(response.status).toBe(200)
    return ((await response.json()) as DesignSnapshotResponse).snapshot
  }

  test("PNG and JPEG files are added with their bytes on disk, and served back", async () => {
    const layout = await snapshotOf(
      await uploadSnapshot(h, id, "layout.png", png)
    )
    const detail = await snapshotOf(
      await uploadSnapshot(h, id, "detail.jpeg", jpeg)
    )

    expect(stored(h).tray[0].finding.designSnapshots).toEqual([layout, detail])
    expect([layout.name, layout.mediaType]).toEqual(["layout.png", "png"])
    expect([detail.name, detail.mediaType]).toEqual(["detail.jpeg", "jpeg"])
    expect(files(h, "design-snapshots", id)).toEqual(
      [`${layout.dataVersion}.png`, `${detail.dataVersion}.jpg`].sort()
    )
    const served = await h.app.request(
      `/api/session/findings/${id}/design-snapshot-data/${detail.dataVersion}`
    )
    expect(served.headers.get("Content-Type")).toBe("image/jpeg")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg)
  })

  test("each rejected file says why, and never becomes part of the Finding", async () => {
    const rejected = await Promise.all([
      uploadSnapshot(
        h,
        id,
        "notes.pdf",
        new TextEncoder().encode("not a PDF image")
      ),
      uploadSnapshot(
        h,
        id,
        "broken.png",
        new TextEncoder().encode("not an image")
      ),
      uploadSnapshot(h, id, "photo.jpg", png),
    ])

    expect(await Promise.all(rejected.map(errorOf))).toEqual([
      {
        status: 400,
        error: ".pdf is not supported. Choose a PNG or JPEG image.",
      },
      { status: 400, error: "Choose a readable PNG or JPEG image." },
      { status: 400, error: "This image is not a valid JPEG file." },
    ])
    expect(stored(h).tray[0].finding.designSnapshots).toEqual([])
    expect(files(h, "design-snapshots")).toEqual([])
  })

  test("rename keeps the extension truthful; replace keeps the place, mints a version and drops the old file", async () => {
    const first = await snapshotOf(
      await uploadSnapshot(h, id, "button.png", png)
    )
    const second = await snapshotOf(
      await uploadSnapshot(h, id, "other.png", png)
    )

    const renamed = await snapshotOf(
      await send(
        h,
        "PATCH",
        `/api/session/findings/${id}/design-snapshots/${first.id}`,
        { name: "approved.jpg" }
      )
    )
    const replaced = await snapshotOf(
      await uploadSnapshot(h, id, "new-button.jpg", jpeg, first.id)
    )

    expect(renamed.name).toBe("approved.png")
    expect(replaced).toEqual({
      id: first.id,
      dataVersion: replaced.dataVersion,
      name: "approved.jpg",
      mediaType: "jpeg",
    })
    expect(replaced.dataVersion).not.toBe(first.dataVersion)
    expect(stored(h).tray[0].finding.designSnapshots).toEqual([
      replaced,
      second,
    ])
    expect(files(h, "design-snapshots", id)).toEqual(
      [`${replaced.dataVersion}.jpg`, `${second.dataVersion}.png`].sort()
    )
  })

  test("remove drops the snapshot and its file", async () => {
    const snapshot = await snapshotOf(
      await uploadSnapshot(h, id, "spec.png", otherPNG)
    )

    const response = await send(
      h,
      "DELETE",
      `/api/session/findings/${id}/design-snapshots/${snapshot.id}`
    )

    expect(response.status).toBe(204)
    expect(stored(h).tray[0].finding.designSnapshots).toEqual([])
    expect(files(h, "design-snapshots")).toEqual([])
  })

  test("a reload sees the Tray with its Design Snapshots", async () => {
    const snapshot = await snapshotOf(
      await uploadSnapshot(h, id, "spec.png", png)
    )

    const state = (await (
      await h.app.request("/api/review")
    ).json()) as ReviewStateResponse

    expect(state.session?.tray[0].finding.designSnapshots).toEqual([snapshot])
  })
})

describe("Label sprites", () => {
  test("a label's glyphs are served as an immutable PNG; a malformed query is refused", async () => {
    const h = harness()

    const sprite = await h.app.request(
      "/api/label-sprite?text=Too%20tight&color=red&size=47&offset=0.25"
    )
    const refused = await Promise.all(
      [
        "text=&color=red&size=47&offset=0",
        "text=x&color=pink&size=47&offset=0",
        "text=x&color=red&size=0&offset=0",
        "text=x&color=red&size=47.5&offset=0",
        "text=x&color=red&size=47&offset=1",
        "text=x&color=red&size=47",
      ].map((query) => h.app.request(`/api/label-sprite?${query}`))
    )

    expect(sprite.status).toBe(200)
    expect(sprite.headers.get("Content-Type")).toBe("image/png")
    expect(sprite.headers.get("Cache-Control")).toContain("immutable")
    expect(refused.map((response) => response.status)).toEqual([
      400, 400, 400, 400, 400, 400,
    ])
  })
})
