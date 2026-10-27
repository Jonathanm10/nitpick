// Ports Tests/NitpickCoreTests/DurabilityTests.swift: what a save writes, a
// relaunch reads back, and File all saves every acknowledged step, so a crash
// mid-run resumes without repeating any. FakeFilingStore keeps the open
// session and History as the v1 JSON, so a relaunch here decodes exactly the
// bytes the last save wrote.
//
// Not ported: clearing an abandoned session, the empty workspace, and healing
// a fully filed session stuck in the open slot on load. Those are the
// server's storage, which writes the files.
import { describe, expect, test } from "vitest"
import { AnnotationHistory, type Annotation } from "../src/annotation.ts"
import type { HistoryEntry } from "../src/history.ts"
import { fileAll } from "../src/issueFiling.ts"
import {
  addFinding,
  discardFinding,
  filedIssueOf,
  filedIssues,
  isEditable,
  newFinding,
  updateFinding,
  type ReviewSession,
} from "../src/reviewSession.ts"
import {
  decodeStoredHistoryEntry,
  decodeStoredSession,
  encodeStoredHistoryEntry,
  encodeStoredSession,
  MalformedStoredData,
} from "../src/storage.ts"
import { FakeFilingStore } from "./FakeFilingStore.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

const { urls } = fixtures

describe("Crash-safe sessions and history", () => {
  test("killing the app mid-session and relaunching restores the open session — tray, descriptions, editable Annotations", () => {
    const annotations: Annotation[] = [
      {
        kind: "pen",
        color: "yellow",
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      { kind: "arrow", color: "red", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
      {
        kind: "rectangle",
        color: "blue",
        rect: { x: 10, y: 20, width: 30, height: 40 },
      },
      { kind: "label", color: "white", text: "Wrong red", at: { x: 9, y: 10 } },
    ]
    const annotated = addFinding(fixtures.session, {
      ...newFinding({
        summary: "Button color is off",
        description: "The primary button is #FF0000, the design says #E64545.",
        deviceContext: {
          deviceModel: "iPhone 17 Pro",
          osName: "iOS 26.4",
          accessibilitySettings: [],
        },
        designReference: "https://www.figma.com/design/abc/buttons",
      }),
      annotations,
    })
    const second = addFinding(
      annotated.session,
      newFinding({
        summary: "",
        description: "",
        deviceContext: {
          deviceModel: "iPad Pro 13-inch (M4)",
          osName: "iOS 26.4",
          accessibilitySettings: ["Dynamic Type XL", "Dark Mode"],
        },
      })
    )
    // Later edits persist too — the newest save wins.
    const session = updateFinding(second.session, second.id, (finding) => ({
      ...finding,
      summary: "Label truncates",
    }))
    const saved = encodeStoredSession(session)

    const resumed = decodeStoredSession(saved)
    expect(resumed).toEqual(session)

    // Annotations are still editable after the relaunch (the pre-kill undo
    // history is not carried across it)…
    const history = new AnnotationHistory(resumed.tray[0].finding.annotations)
    expect(history.canUndo).toBe(false)
    const edited = history.removeAnnotation(0)
    expect(edited.annotations).toHaveLength(3)
    expect(edited.canUndo).toBe(true)
  })

  test("a session persisted before Type shipped still decodes — its Findings default to Bug — and files to completion", async () => {
    const { session } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Filed by an older nitpick" })
    )
    const stored = JSON.parse(encodeStoredSession(session))
    // The pre-Type shape: no `type` key on any tray item.
    for (const item of stored.tray) delete item.type

    const reloaded = decodeStoredSession(JSON.stringify(stored))

    expect(reloaded.tray[0].finding.type).toBe("bug")
    expect(reloaded).toEqual(session)

    // And it files to completion: the Bug Type tag is resolved and applied.
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    const outcome = await fileAll(reloaded, fixtures.filing(transport))
    expect(outcome.failure).toBeUndefined()
    expect(filedIssues(outcome.session)).toEqual([
      fixtures.filedIssue("RM-421"),
    ])
  })

  test("a discarded Finding stays discarded after the relaunch", () => {
    const kept = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Keep me" })
    )
    const dropped = addFinding(
      kept.session,
      fixtures.finding({ summary: "Not a real problem" })
    )
    const session = discardFinding(dropped.session, dropped.id)

    const resumed = decodeStoredSession(encodeStoredSession(session))

    expect(resumed).toEqual(session)
    expect(resumed.tray.map((item) => item.finding.summary)).toEqual([
      "Keep me",
    ])
  })

  test("the session-level Design Reference survives the relaunch", () => {
    const { session } = addFinding(
      {
        ...fixtures.session,
        designReference: "https://www.figma.com/file/sess42/ReviewMe",
      },
      fixtures.finding()
    )

    const resumed = decodeStoredSession(encodeStoredSession(session))

    expect(resumed).toEqual(session)
    expect(resumed.designReference).toBe(
      "https://www.figma.com/file/sess42/ReviewMe"
    )
  })

  test("a corrupt open-session file is a thrown error, not a silently empty state", () => {
    const { session } = addFinding(fixtures.session, fixtures.finding())
    const valid = encodeStoredSession(session)

    expect(() => decodeStoredSession("not json")).toThrow(MalformedStoredData)
    // Valid JSON in the wrong shape is just as corrupt.
    expect(() =>
      decodeStoredSession(valid.replace('"summary":', '"summery":'))
    ).toThrow(MalformedStoredData)
    expect(() =>
      decodeStoredSession(valid.replace('"type":"bug"', '"type":"feature"'))
    ).toThrow(MalformedStoredData)
  })

  test("a crash mid-file-all loses no server-acknowledged step: the relaunch resumes mid-ladder and retry files only the remainder", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const session = fixtures.sessionWith(["First", "Second", "Third"])
    await store.saveOpenSession(session)

    // First files whole; Second's Issue is created, then the network dies at
    // its attachments request, and the server with it.
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    transport.enqueue(fixtures.createdIssue422)
    transport.enqueueError(new TypeError("network connection lost"))
    const outcome = await fileAll(session, fixtures.filing(transport, store))
    expect(outcome.failure).toBeDefined()

    // Nothing in memory survives; the relaunch reads back every mark the run
    // recorded before it died.
    const resumed = store.loadOpenSession()
    if (resumed === undefined) throw new Error("the open session was lost")
    expect(filedIssueOf(resumed.tray[0])).toEqual(fixtures.filedIssue("RM-421"))
    expect(resumed.tray[1].filingProgress).toEqual({
      state: "issueCreated",
      issueID: "3-506",
      idReadable: "RM-422",
    })
    expect(isEditable(resumed.tray[1])).toBe(false)
    expect(isEditable(resumed.tray[2])).toBe(true)

    // Retry: Second resumes at its attachments, never a second Issue, and
    // Third files fresh.
    const transport2 = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport2)
    transport2.enqueue(fixtures.attachmentsJSON)
    transport2.enqueue(fixtures.appliedTagJSON)
    transport2.enqueue(fixtures.appliedTypeTagJSON)
    fixtures.enqueueLadder(transport2, fixtures.createdIssue423)
    const retry = await fileAll(resumed, fixtures.filing(transport2, store))
    expect(retry.failure).toBeUndefined()
    expect(filedIssues(retry.session)).toEqual([
      fixtures.filedIssue("RM-421"),
      fixtures.filedIssue("RM-422"),
      fixtures.filedIssue("RM-423"),
    ])
    expect(transport2.urls).toEqual([
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.attachments("3-506"),
      urls.tags("3-506"),
      urls.tags("3-506"),
      urls.createIssue,
      urls.attachments("3-507"),
      urls.tags("3-507"),
      urls.tags("3-507"),
    ])

    // The fully filed session left the open slot and became History.
    expect(store.loadOpenSession()).toBeUndefined()
    const history = store.sessionHistory()
    expect(history).toHaveLength(1)
    expect(
      history[0].findings.map((finding) => finding.issue.idReadable)
    ).toEqual(["RM-421", "RM-422", "RM-423"])
  })

  test("a File all whose session cannot be saved stops before any request: no orphan issue, the session file as it was", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const added = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Saved" })
    )
    await store.saveOpenSession(added.session)
    const session = updateFinding(added.session, added.id, (finding) => ({
      ...finding,
      summary: "Saved, then typed",
    }))
    const savedManifest = store.openSessionJSON

    store.refusesSaves = true
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    const failed = await fileAll(session, fixtures.filing(transport, store))

    expect(failed.failure).toBeDefined()
    expect(transport.sentRequests).toEqual([])
    expect(store.openSessionJSON).toBe(savedManifest)

    store.refusesSaves = false
    const filed = await fileAll(session, fixtures.filing(transport, store))

    expect(filed.failure).toBeUndefined()
    expect(
      store.sessionHistory()[0]?.findings.map((finding) => finding.summary)
    ).toEqual(["Saved, then typed"])
  })

  test("filed sessions land in history with their issue links — read from disk, never from YouTrack", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const session = fixtures.sessionWith([
      "Toolbar icon is misaligned",
      "Label truncates",
    ])
    await store.saveOpenSession(session)
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    const outcome = await fileAll(session, fixtures.filing(transport, store))
    expect(outcome.failure).toBeUndefined()
    expect(store.loadOpenSession()).toBeUndefined()

    // History is a log: reading it fetches no YouTrack state.
    const requestsBefore = transport.sentRequests.length
    const history = store.sessionHistory()
    expect(transport.sentRequests).toHaveLength(requestsBefore)

    const deviceContext = {
      deviceModel: "iPhone 17 Pro",
      osName: "iOS 26.4",
      accessibilitySettings: [],
    }
    const expected: HistoryEntry = {
      build: session.build.identity,
      project: session.project,
      startedAt: session.startedAt,
      findings: [
        {
          summary: "Toolbar icon is misaligned",
          description:
            "The primary button is #FF0000, the design says #E64545.",
          deviceContext,
          issue: fixtures.filedIssue("RM-421"),
        },
        {
          summary: "Label truncates",
          description:
            "The primary button is #FF0000, the design says #E64545.",
          deviceContext,
          issue: fixtures.filedIssue("RM-422"),
        },
      ],
    }
    expect(history).toEqual([expected])
    expect(
      decodeStoredHistoryEntry(encodeStoredHistoryEntry(expected))
    ).toEqual(expected)

    // A later session files: History lists newest first.
    const later: ReviewSession = addFinding(
      { ...fixtures.session, startedAt: session.startedAt + 3600 },
      fixtures.finding({ summary: "Spacing is off" })
    ).session
    await store.saveOpenSession(later)
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue423)
    expect(
      (await fileAll(later, fixtures.filing(transport, store))).failure
    ).toBeUndefined()

    expect(store.sessionHistory().map((entry) => entry.startedAt)).toEqual([
      later.startedAt,
      session.startedAt,
    ])
  })

  test("the Design line freezes with the issue: a session-level edit between a failed run and its retry never rewrites history", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const referenceA = "https://www.figma.com/file/revA/ReviewMe"
    const referenceB = "https://www.figma.com/file/revB/ReviewMe"
    const session = fixtures.sessionWith(["First", "Second"])
    const withReference: ReviewSession = {
      ...session,
      designReference: referenceA,
    }
    await store.saveOpenSession(withReference)

    // First's Issue is created under reference A, then the network dies at
    // its attachments request.
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.createdIssue421)
    transport.enqueueError(new TypeError("network connection lost"))
    const outcome = await fileAll(
      withReference,
      fixtures.filing(transport, store)
    )
    expect(outcome.failure).toBeDefined()
    // The reference the Issue was filed under is frozen on the item.
    expect(outcome.session.tray[0].finding.designReference).toBe(referenceA)

    // The designer repoints the session before retrying: First's Issue
    // already says A on the instance, Second files under B.
    const repointed = { ...outcome.session, designReference: referenceB }
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.attachmentsJSON)
    transport.enqueue(fixtures.appliedTagJSON)
    transport.enqueue(fixtures.appliedTypeTagJSON)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    const retry = await fileAll(repointed, fixtures.filing(transport, store))
    expect(retry.failure).toBeUndefined()

    // First's creation body carried A; Second's carried B.
    const creations = transport.sentRequests
      .filter((request) => request.url === urls.createIssue)
      .map((request) => bodyText(request) ?? "")
    expect(creations).toHaveLength(2)
    expect(creations[0]).toContain(String.raw`Design: ${referenceA}\n`)
    expect(creations[1]).toContain(String.raw`Design: ${referenceB}\n`)

    // History records what each Issue actually says: A, then B.
    const history = store.sessionHistory()
    expect(history).toHaveLength(1)
    expect(
      history[0].findings.map((finding) => finding.designReference)
    ).toEqual([referenceA, referenceB])
  })

  test("captures filed after a file-all extend the same session's history entry — never a duplicate", async () => {
    const transport = new FakeHTTPTransport()
    const store = new FakeFilingStore(fixtures.pngBytes)
    const session = fixtures.sessionWith(["First"])
    await store.saveOpenSession(session)
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    const outcome = await fileAll(session, fixtures.filing(transport, store))
    expect(outcome.failure).toBeUndefined()

    // The designer keeps reviewing and files once more.
    const again = addFinding(
      outcome.session,
      fixtures.finding({ summary: "One more" })
    ).session
    await store.saveOpenSession(again)
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    expect(
      (await fileAll(again, fixtures.filing(transport, store))).failure
    ).toBeUndefined()

    const history = store.sessionHistory()
    expect(history).toHaveLength(1)
    expect(
      history[0].findings.map((finding) => finding.issue.idReadable)
    ).toEqual(["RM-421", "RM-422"])
  })
})
