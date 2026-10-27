// Ports the filing parts of Tests/NitpickCoreTests/DesignSnapshotScenarioTests.swift:
// Design Snapshots file as extra attachments after annotated.png and
// original.png, under names that never collide, with their own media type.
//
// Not ported: adding, renaming, replacing, removing and validating Design
// Snapshots, their files on disk and their deletion once filed. Those are the
// Editor's and the server's storage.
import { describe, expect, test } from "vitest"
import {
  effectiveAttachmentNames,
  type DesignSnapshot,
} from "../src/designSnapshot.ts"
import { fileAll } from "../src/issueFiling.ts"
import {
  addFinding,
  updateFinding,
  type ReviewSession,
} from "../src/reviewSession.ts"
import { decodeStoredSession, encodeStoredSession } from "../src/storage.ts"
import { FakeFilingStore } from "./FakeFilingStore.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

function snapshot(
  id: string,
  name: string,
  mediaType: DesignSnapshot["mediaType"] = "png"
): DesignSnapshot {
  return { id, dataVersion: id, name, mediaType }
}

function withSnapshots(
  store: FakeFilingStore,
  snapshots: ReadonlyArray<{ snapshot: DesignSnapshot; data: Uint8Array }>
): ReviewSession {
  const { session, id } = addFinding(fixtures.session, fixtures.finding())
  for (const { snapshot, data } of snapshots) {
    store.designSnapshots.set(snapshot.dataVersion, data)
  }
  return updateFinding(session, id, (finding) => ({
    ...finding,
    designSnapshots: snapshots.map(({ snapshot }) => snapshot),
  }))
}

function enqueueFiling(
  transport: FakeHTTPTransport,
  attachments: string
): void {
  fixtures.enqueueTagLookups(transport)
  transport.enqueue(fixtures.createdIssue421)
  transport.enqueue(attachments)
  transport.enqueue(fixtures.appliedTagJSON)
  transport.enqueue(fixtures.appliedTypeTagJSON)
}

// Distinct bytes per image: what matters is which bytes ride which part.
const specA = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xa1])
const specB = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xb2])
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xc3])

describe("Design Snapshots", () => {
  test("one PNG survives relaunch, files separately, and leaves the open slot for History", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const session = withSnapshots(store, [
      {
        snapshot: snapshot(
          "00000000-0000-4000-8000-000000000031",
          "button-spec.png"
        ),
        data: specA,
      },
    ])
    await store.saveOpenSession(session)

    const resumed = store.loadOpenSession()
    if (resumed === undefined) throw new Error("the open session was lost")
    expect(resumed.tray[0].finding.designSnapshots).toEqual(
      session.tray[0].finding.designSnapshots
    )

    enqueueFiling(
      transport,
      `[{"id":"134-31","name":"annotated.png"},{"id":"134-32","name":"original.png"},{"id":"134-33","name":"button-spec.png"}]`
    )
    const outcome = await fileAll(resumed, fixtures.filing(transport, store))
    expect(outcome.failure).toBeUndefined()

    expect(bodyText(transport.sentRequests[2])).toBe(fixtures.expectedIssueJSON)
    const attach = transport.sentRequests[3]
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "annotated.png", data: fixtures.pngBytes },
        { fileName: "original.png", data: fixtures.pngBytes },
        { fileName: "button-spec.png", data: specA },
      ])
    )

    expect(store.loadOpenSession()).toBeUndefined()
    expect(store.sessionHistory()[0]?.findings[0]?.issue.idReadable).toBe(
      "RM-421"
    )
  })

  test("duplicate snapshot names file deterministically without changing designer-facing names", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const session = withSnapshots(store, [
      {
        snapshot: snapshot("00000000-0000-4000-8000-000000000041", "spec.png"),
        data: specA,
      },
      {
        snapshot: snapshot("00000000-0000-4000-8000-000000000042", "spec.png"),
        data: specB,
      },
    ])
    enqueueFiling(
      transport,
      `[{"id":"1","name":"annotated.png"},{"id":"2","name":"original.png"},{"id":"3","name":"spec.png"},{"id":"4","name":"spec (2).png"}]`
    )

    const outcome = await fileAll(session, fixtures.filing(transport, store))

    expect(outcome.failure).toBeUndefined()
    expect(
      outcome.session.tray[0].finding.designSnapshots.map((s) => s.name)
    ).toEqual(["spec.png", "spec.png"])
    const attach = transport.sentRequests[3]
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "annotated.png", data: fixtures.pngBytes },
        { fileName: "original.png", data: fixtures.pngBytes },
        { fileName: "spec.png", data: specA },
        { fileName: "spec (2).png", data: specB },
      ])
    )
  })

  test("JPEG files retain their extension, media type, and bytes on the wire", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const session = withSnapshots(store, [
      {
        snapshot: snapshot(
          "00000000-0000-4000-8000-000000000051",
          "expected-state.jpeg",
          "jpeg"
        ),
        data: jpeg,
      },
    ])
    enqueueFiling(
      transport,
      `[{"id":"1","name":"annotated.png"},{"id":"2","name":"original.png"},{"id":"3","name":"expected-state.jpeg"}]`
    )

    await fileAll(session, fixtures.filing(transport, store))

    const attach = transport.sentRequests[3]
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "annotated.png", data: fixtures.pngBytes },
        { fileName: "original.png", data: fixtures.pngBytes },
        { fileName: "expected-state.jpeg", data: jpeg },
      ])
    )
  })

  // Not in the Swift suite: the stored manifest names the snapshot the way
  // the ladder files it, so a v1 session from the Swift app files the same.
  test("a stored manifest's snapshots file from their dataVersion's bytes", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const replaced: DesignSnapshot = {
      id: "00000000-0000-4000-8000-000000000061",
      dataVersion: "00000000-0000-4000-8000-000000000062",
      name: "approved.png",
      mediaType: "png",
    }
    store.designSnapshots.set(replaced.dataVersion, specB)
    const { session, id } = addFinding(fixtures.session, fixtures.finding())
    const stored = decodeStoredSession(
      encodeStoredSession(
        updateFinding(session, id, (finding) => ({
          ...finding,
          designSnapshots: [replaced],
        }))
      )
    )
    enqueueFiling(
      transport,
      `[{"id":"1","name":"annotated.png"},{"id":"2","name":"original.png"},{"id":"3","name":"approved.png"}]`
    )

    await fileAll(stored, fixtures.filing(transport, store))

    const attach = transport.sentRequests[3]
    expect(attach.body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(attach), [
        { fileName: "annotated.png", data: fixtures.pngBytes },
        { fileName: "original.png", data: fixtures.pngBytes },
        { fileName: "approved.png", data: specB },
      ])
    )
  })
})

// Not in the Swift suite: DesignSnapshot.swift's effectiveAttachmentNames over
// the names a rename allows, with NSString's path extension rules as probed
// with swift on macOS 27.
describe("Design Snapshot attachment names", () => {
  test.each([
    { names: ["spec.png", "SPEC.png"], filed: ["spec.png", "SPEC (2).png"] },
    { names: ["annotated.png"], filed: ["annotated (2).png"] },
    { names: ["Original.PNG"], filed: ["Original (2).PNG"] },
    { names: ["spec"], filed: ["spec.png"] },
    { names: [".png"], filed: [".png.png"] },
    { names: ["spec."], filed: ["spec..png"] },
    {
      names: ["a.b.png", "a.b.png", "a.b.png"],
      filed: ["a.b.png", "a.b (2).png", "a.b (3).png"],
    },
    {
      names: ["spec (2).png", "spec.png", "spec.png"],
      filed: ["spec (2).png", "spec.png", "spec (3).png"],
    },
  ])("$names file as $filed", ({ names, filed }) => {
    const snapshots = names.map((name, index) =>
      snapshot(`00000000-0000-4000-8000-0000000001${index}0`, name)
    )

    expect(
      effectiveAttachmentNames(snapshots, ["annotated.png", "original.png"])
    ).toEqual(filed)
  })

  test("a JPEG without an extension files as .jpg", () => {
    expect(
      effectiveAttachmentNames(
        [snapshot("00000000-0000-4000-8000-000000000201", "mock", "jpeg")],
        []
      )
    ).toEqual(["mock.jpg"])
  })
})
