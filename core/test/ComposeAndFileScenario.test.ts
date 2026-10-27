// Ports the core half of Tests/NitpickCoreTests/ComposeAndFileScenarioTests.swift:
// connect, choose the project once, compose a Finding, and file it as exactly
// one Issue with its metadata block, screenshots and tags.
//
// Not ported: ingesting the Build, booting, launching and capturing. Those
// run on the Device Host (server/, issue 06). The Annotations' real pixels
// are checked in server/test/AnnotatedFiling.test.ts.
import { describe, expect, test } from "vitest"
import { AnnotationHistory } from "../src/annotation.ts"
import { fileAll } from "../src/issueFiling.ts"
import {
  addFinding,
  filedIssueOf,
  newFinding,
  newReviewSession,
} from "../src/reviewSession.ts"
import {
  verifyYouTrack,
  YouTrackClient,
  YouTrackCredentials,
} from "../src/youtrack.ts"
import { FakeFilingStore } from "./FakeFilingStore.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

const { projectsJSON, userJSON } = fixtures

const build = {
  identity: {
    bundleID: "ch.liip.reviewme",
    version: "2.1.0",
    buildNumber: "421",
  },
  appBundleURL: "file:///tmp/ReviewMe.app/",
}

describe("Compose and file scenario", () => {
  test("a captured Finding files as exactly one issue with metadata block, screenshot, and tag", async () => {
    // The designer connected to YouTrack…
    const transport = new FakeHTTPTransport()
    transport.enqueue(userJSON)
    transport.enqueue(projectsJSON)
    const youTrack = new YouTrackClient(
      transport,
      new YouTrackCredentials("https://youtrack.example.com", fixtures.token)
    )
    const connection = await verifyYouTrack(youTrack)

    // …and starts the Review Session by choosing the project, once.
    const project = connection.projects.find(
      (candidate) => candidate.shortName === "RM"
    )
    if (project === undefined) throw new Error("no RM project")
    const session = newReviewSession({
      build,
      project,
      startedAt: fixtures.session.startedAt,
    })

    // A capture, composed into a Finding with its Device Context…
    const capture = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42,
    ])
    const { session: composed, id } = addFinding(
      session,
      newFinding({
        summary: "Toolbar icon is misaligned",
        description: "The share icon sits 2pt too low.",
        deviceContext: {
          deviceModel: "iPhone 17 Pro",
          osName: "iOS 26.4",
          accessibilitySettings: [],
        },
      })
    )
    const store = new FakeFilingStore(fixtures.pngBytes)
    store.captures.set(id, capture)

    // …files as exactly one Issue, and the ID and link come back.
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)
    const outcome = await fileAll(composed, {
      youTrack,
      store,
      flatten: fixtures.fakeFlatten,
    })
    expect(filedIssueOf(outcome.session.tray[0])).toEqual({
      idReadable: "RM-421",
      url: "https://youtrack.example.com/issue/RM-421",
    })

    // The exact filing requests, after the two connect requests.
    const base = "https://youtrack.example.com"
    expect(transport.urls.slice(2)).toEqual([
      `${base}/api/tags?fields=id,name&query=design-review&$top=100`,
      `${base}/api/tags?fields=id,name&query=nitpick-type:bug&$top=100`,
      `${base}/api/issues?fields=id,idReadable`,
      `${base}/api/issues/3-505/attachments?fields=id,name`,
      `${base}/api/issues/3-505/tags?fields=id,name`,
      `${base}/api/issues/3-505/tags?fields=id,name`,
    ])

    // Issue JSON: designer text and the metadata block stamped from the
    // Build identity and the capture's Device Context.
    expect(bodyText(transport.sentRequests[4])).toBe(
      String.raw`{"description":"The share icon sits 2pt too low.\n\n` +
        String.raw`---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n` +
        String.raw`Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},` +
        String.raw`"summary":"Toolbar icon is misaligned"}`
    )

    // Both variants ride the attachment; unannotated, the annotated variant
    // is the captured bytes unchanged.
    const attach = transport.sentRequests[5]
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "annotated.png", data: capture },
        { fileName: "original.png", data: capture },
      ])
    )

    // The design-review tag lands by ID; the Type tag follows it.
    expect(bodyText(transport.sentRequests[6])).toBe(`{"id":"6-4"}`)
  })

  test("Annotations stay editable until filing; the filed issue carries annotated and clean original", async () => {
    const transport = new FakeHTTPTransport()
    const { session, id } = addFinding(
      fixtures.session,
      newFinding({
        summary: "Share icon is misaligned",
        description: "It sits 2pt too low.",
        deviceContext: {
          deviceModel: "iPhone 17 Pro",
          osName: "iOS 26.4",
          accessibilitySettings: [],
        },
      })
    )

    // Marked up with all four tools…
    let history = new AnnotationHistory([])
      .add({
        kind: "pen",
        color: "red",
        points: [
          { x: 40, y: 80 },
          { x: 120, y: 160 },
        ],
      })
      .add({
        kind: "arrow",
        color: "blue",
        from: { x: 300, y: 500 },
        to: { x: 200, y: 420 },
      })
      .add({
        kind: "rectangle",
        color: "yellow",
        rect: { x: 80, y: 300, width: 200, height: 120 },
      })
      .add({
        kind: "label",
        color: "white",
        text: "2pt off",
        at: { x: 90, y: 440 },
      })
    expect(history.annotations).toHaveLength(4)

    // …then refined while reviewing: the label moves, a stray pen stroke is
    // undone, and the label move survives it…
    const movedLabel = {
      kind: "label",
      color: "white",
      text: "2pt off",
      at: { x: 90, y: 470 },
    } as const
    history = history
      .replaceAnnotation(3, movedLabel)
      .add({
        kind: "pen",
        color: "red",
        points: [
          { x: 10, y: 10 },
          { x: 12, y: 12 },
        ],
      })
      .undo()
    expect(history.annotations).toHaveLength(4)
    expect(history.annotations[3]).toEqual(movedLabel)

    // …and one undo too many is taken back with redo.
    history = history.undo()
    expect(history.annotations[3]).toMatchObject({ at: { x: 90, y: 440 } })
    history = history.redo()
    expect(history.annotations[3]).toEqual(movedLabel)

    // Filing freezes exactly this state into the annotated attachment, next
    // to the untouched original.
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)
    const annotated = {
      ...session,
      tray: session.tray.map((item) =>
        item.id === id
          ? {
              ...item,
              finding: { ...item.finding, annotations: history.annotations },
            }
          : item
      ),
    }
    await fileAll(annotated, fixtures.filing(transport))

    const flattened = await fixtures.fakeFlatten(
      fixtures.pngBytes,
      history.annotations
    )
    expect(flattened).not.toEqual(fixtures.pngBytes)
    const attach = transport.sentRequests[3]
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "annotated.png", data: flattened },
        { fileName: "original.png", data: fixtures.pngBytes },
      ])
    )
  })
})
