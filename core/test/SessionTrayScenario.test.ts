// Ports Tests/NitpickCoreTests/SessionTrayScenarioTests.swift: captures drop
// Findings into the Tray, the Tray is edited and pruned, and File all turns
// every remaining Finding into exactly one Issue. Filing records every
// server-acknowledged step before the next request, so a failure mid-run
// loses nothing and a retry never repeats what the instance acknowledged.
//
// Not ported: File all before connecting. Filing takes a YouTrackClient, so
// there is no unconnected call to make.
import { describe, expect, test } from "vitest"
import type { Annotation } from "../src/annotation.ts"
import { fileAll } from "../src/issueFiling.ts"
import {
  addFinding,
  discardFinding,
  filedIssueOf,
  filedIssues,
  hasUnfiledFindings,
  isEditable,
  isPristine,
  unfiledFindingCount,
  updateFinding,
  type ReviewSession,
  type TrayItem,
} from "../src/reviewSession.ts"
import type { YouTrackError } from "../src/youtrack.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

const { urls } = fixtures

function item(session: ReviewSession, id: string): TrayItem {
  const found = session.tray.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no tray item ${id}`)
  return found
}

function rectangle(
  x: number,
  y: number,
  width: number,
  height: number
): Annotation {
  return { kind: "rectangle", color: "red", rect: { x, y, width, height } }
}

describe("Session tray and file-all", () => {
  // The pristine predicate

  test("a fresh capture is pristine; annotation round-trips away and back", () => {
    const { session: added, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "", description: "" })
    )
    let session = added
    expect(isPristine(item(session, id))).toBe(true)

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      annotations: [...finding.annotations, rectangle(40, 40, 100, 80)],
    }))
    expect(isPristine(item(session, id))).toBe(false)

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      annotations: finding.annotations.slice(1),
    }))
    expect(isPristine(item(session, id))).toBe(true)
  })

  test("whitespace-only summary and description still count as pristine", () => {
    const { session, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: " \n\t", description: "  \n" })
    )

    expect(isPristine(item(session, id))).toBe(true)
  })

  // The same case over every scalar of Swift's .whitespacesAndNewlines, as
  // probed with swift on macOS 27, which JS's trim doesn't match exactly.
  test.each(
    [
      0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
      0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x200b,
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ].map((scalar) => [
      scalar.toString(16).toUpperCase().padStart(4, "0"),
      scalar,
    ])
  )(
    "whitespace-only summary and description still count as pristine (U+%s)",
    (_hex, scalar) => {
      const space = String.fromCodePoint(scalar)
      const { session, id } = addFinding(
        fixtures.session,
        fixtures.finding({ summary: space, description: space })
      )

      expect(isPristine(item(session, id))).toBe(true)
    }
  )

  test("a summary of U+FEFF alone is not whitespace to Swift", () => {
    const { session, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "\ufeff", description: "" })
    )

    expect(isPristine(item(session, id))).toBe(false)
  })

  test("Esc keeps a Finding that carries only a pasted Design Snapshot", () => {
    const { session: added, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "", description: "" })
    )
    let session = added

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      designSnapshots: [
        {
          id: "00000000-0000-4000-8000-000000000030",
          dataVersion: "00000000-0000-4000-8000-000000000030",
          name: "checkout-spec.png",
          mediaType: "png",
        },
      ],
    }))

    expect(isPristine(item(session, id))).toBe(false)
  })

  test("Esc keeps a Finding that carries only its own Design Reference", () => {
    const { session: added, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "", description: "" })
    )
    let session = added

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      designReference: "https://www.figma.com/design/abc123/Checkout",
    }))

    expect(isPristine(item(session, id))).toBe(false)
  })

  test("Esc keeps a Finding the designer switched to Improvement", () => {
    const { session: added, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "", description: "" })
    )
    let session = added

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      type: "improvement",
    }))

    expect(isPristine(item(session, id))).toBe(false)
  })

  test("Esc keeps a Finding that carries only a Priority", () => {
    const { session: added, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "", description: "" })
    )
    let session = added

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      priority: { name: "Critical" },
    }))

    expect(isPristine(item(session, id))).toBe(false)
  })

  test("Esc keeps a Finding that carries only an Assignee", () => {
    const { session: added, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "", description: "" })
    )
    let session = added

    session = updateFinding(session, id, (finding) => ({
      ...finding,
      assignee: { login: "mira.sol", fullName: "Mira Sol" },
    }))

    expect(isPristine(item(session, id))).toBe(false)
  })

  test.each(fixtures.filingMarks)(
    "any filing mark makes a tray item permanently non-pristine ($state)",
    (mark) => {
      const added = addFinding(
        fixtures.session,
        fixtures.finding({ summary: "Ready to file" })
      )

      const session = fixtures.withFilingProgress(added.session, added.id, mark)

      expect(isPristine(item(session, added.id))).toBe(false)
      expect(isEditable(item(session, added.id))).toBe(false)
    }
  )

  // The tray

  test("captures land in the tray as Findings with their screenshots — no filing traffic until file-all", () => {
    // Capturing is the Device Host's (server/); the core half is that each
    // capture lands in capture order, editable, with nothing filed.
    const first = addFinding(fixtures.session, fixtures.finding())
    const second = addFinding(first.session, fixtures.finding())
    const session = second.session

    expect(session.tray.map((candidate) => candidate.id)).toEqual([
      first.id,
      second.id,
    ])
    expect(session.tray.every(isEditable)).toBe(true)
    expect(filedIssues(session)).toEqual([])
  })

  test("tray items are edited in place and discarded before filing", () => {
    const kept = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Keep" })
    )
    const dropped = addFinding(
      kept.session,
      fixtures.finding({ summary: "Drop" })
    )
    let session = updateFinding(dropped.session, kept.id, (finding) => ({
      ...finding,
      summary: "Keep — sharpened",
      description: "Now with reproduction steps.",
      annotations: [...finding.annotations, rectangle(40, 300, 200, 120)],
    }))
    session = discardFinding(session, dropped.id)

    expect(session.tray).toHaveLength(1)
    const [only] = session.tray
    expect(only.id).toBe(kept.id)
    expect(only.finding.summary).toBe("Keep — sharpened")
    expect(only.finding.description).toBe("Now with reproduction steps.")
    expect(only.finding.annotations).toHaveLength(1)
  })

  // The drop guard's predicate (issue 05)

  test("the tray's filing state drives the unfiled-Findings predicate: empty false, captures true, discard-all false", () => {
    let session = fixtures.session
    expect(hasUnfiledFindings(session)).toBe(false)
    expect(unfiledFindingCount(session)).toBe(0)

    const first = addFinding(session, fixtures.finding({ summary: "First" }))
    const second = addFinding(
      first.session,
      fixtures.finding({ summary: "Second" })
    )
    session = second.session
    expect(hasUnfiledFindings(session)).toBe(true)
    expect(unfiledFindingCount(session)).toBe(2)

    session = discardFinding(session, first.id)
    expect(hasUnfiledFindings(session)).toBe(true)
    expect(unfiledFindingCount(session)).toBe(1)

    session = discardFinding(session, second.id)
    expect(hasUnfiledFindings(session)).toBe(false)
    expect(unfiledFindingCount(session)).toBe(0)
  })

  test("an interrupted filing still counts as unfiled work; file-all clears the predicate", () => {
    const added = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Solo" })
    )

    const interrupted = fixtures.withFilingProgress(added.session, added.id, {
      state: "issueCreated",
      issueID: "3-505",
      idReadable: "RM-421",
    })

    expect(isEditable(item(interrupted, added.id))).toBe(false)
    expect(hasUnfiledFindings(interrupted)).toBe(true)
    expect(unfiledFindingCount(interrupted)).toBe(1)

    const filed = fixtures.withFilingProgress(interrupted, added.id, {
      state: "filed",
      issue: fixtures.filedIssue("RM-421"),
    })

    expect(hasUnfiledFindings(filed)).toBe(false)
    expect(unfiledFindingCount(filed)).toBe(0)
    expect(filedIssues(filed)).toEqual([fixtures.filedIssue("RM-421")])
  })

  // From fileAllHappyPath and resumesAfterIssueCreation: the freeze itself.

  test.each(fixtures.filingMarks)(
    "a filing mark freezes the item: edits and discards are refused ($state)",
    (mark) => {
      const added = addFinding(
        fixtures.session,
        fixtures.finding({ summary: "Solo" })
      )
      const frozen = fixtures.withFilingProgress(added.session, added.id, mark)

      expect(
        updateFinding(frozen, added.id, (finding) => ({
          ...finding,
          summary: "Diverged",
        }))
      ).toBe(frozen)
      expect(discardFinding(frozen, added.id)).toEqual(frozen)
    }
  )
})

describe("Session tray and file-all — File all", () => {
  test("file-all creates exactly one issue per remaining Finding, in tray order, and lists every link", async () => {
    const transport = new FakeHTTPTransport()
    let session = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Toolbar icon is misaligned" })
    ).session
    const dropped = addFinding(
      session,
      fixtures.finding({ summary: "Not a real problem" })
    )
    session = addFinding(
      dropped.session,
      fixtures.finding({ summary: "Label truncates" })
    ).session
    session = discardFinding(session, dropped.id)
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBeUndefined()
    expect(filedIssues(outcome.session)).toEqual([
      fixtures.filedIssue("RM-421"),
      fixtures.filedIssue("RM-422"),
    ])
    expect(outcome.session.tray.map(filedIssueOf)).toEqual([
      fixtures.filedIssue("RM-421"),
      fixtures.filedIssue("RM-422"),
    ])

    // Both tags resolved up front, then create → attach → design-review →
    // Type tag per Finding, in tray order.
    expect(transport.urls).toEqual([
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.createIssue,
      urls.attachments("3-505"),
      urls.tags("3-505"),
      urls.tags("3-505"),
      urls.createIssue,
      urls.attachments("3-506"),
      urls.tags("3-506"),
      urls.tags("3-506"),
    ])
    // Each created Issue carries its own Finding's summary; the discarded
    // one never files.
    const creationBodies = transport.sentRequests
      .filter((request) => request.url === urls.createIssue)
      .map((request) => bodyText(request) ?? "")
    expect(creationBodies).toHaveLength(2)
    expect(creationBodies[0]).toContain(
      `"summary":"Toolbar icon is misaligned"`
    )
    expect(creationBodies[1]).toContain(`"summary":"Label truncates"`)

    // Filed items are History: edits and discards are refused.
    const firstID = outcome.session.tray[0].id
    let after = updateFinding(outcome.session, firstID, (finding) => ({
      ...finding,
      summary: "Too late",
    }))
    after = discardFinding(after, firstID)
    expect(after).toEqual(outcome.session)
  })

  test("a transport failure between Findings keeps every mark; the rest stay editable and retry files only the remainder", async () => {
    const transport = new FakeHTTPTransport()
    const session = fixtures.sessionWith(["First", "Second", "Third"])
    // The network dies on the second Finding's creation request.
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    transport.enqueueError(new TypeError("network connection lost"))

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBeInstanceOf(TypeError)
    expect(filedIssueOf(outcome.session.tray[0])).toEqual(
      fixtures.filedIssue("RM-421")
    )
    expect(isEditable(outcome.session.tray[1])).toBe(true)
    expect(isEditable(outcome.session.tray[2])).toBe(true)
    // Two tag lookups, the first ladder (4) and the failed creation.
    expect(transport.sentRequests).toHaveLength(7)

    // The still-editable second Finding is sharpened before retrying…
    const retried = updateFinding(
      outcome.session,
      outcome.session.tray[1].id,
      (finding) => ({ ...finding, summary: "Second — sharpened" })
    )

    // …and the retry files only the remainder.
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    fixtures.enqueueLadder(transport, fixtures.createdIssue423)

    const second = await fileAll(retried, fixtures.filing(transport))

    expect(second.failure).toBeUndefined()
    expect(filedIssues(second.session)).toEqual([
      fixtures.filedIssue("RM-421"),
      fixtures.filedIssue("RM-422"),
      fixtures.filedIssue("RM-423"),
    ])
    // Exactly one creation per Finding across both runs: the first Finding
    // is never filed twice, and the retried creation carries the sharpened
    // summary.
    const creationBodies = transport.sentRequests
      .filter((request) => request.url === urls.createIssue)
      .map((request) => bodyText(request) ?? "")
    expect(creationBodies).toHaveLength(4) // including the failed attempt
    const count = (summary: string) =>
      creationBodies.filter((body) => body.includes(`"summary":"${summary}"`))
        .length
    expect(count("First")).toBe(1)
    expect(count("Second — sharpened")).toBe(1)
    expect(count("Third")).toBe(1)
  })

  test("a failure after issue creation freezes the item and retry resumes at attachments — never a second issue", async () => {
    const transport = new FakeHTTPTransport()
    const session = fixtures.sessionWith(["Solo"])
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.createdIssue421)
    transport.enqueueError(new TypeError("timed out"))

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBeInstanceOf(TypeError)
    const item = outcome.session.tray[0]
    expect(item.filingProgress).toEqual({
      state: "issueCreated",
      issueID: "3-505",
      idReadable: "RM-421",
    })
    expect(filedIssueOf(item)).toBeUndefined()
    // The Issue exists on the instance, so the item froze: an edit now would
    // diverge from what RM-421 already says.
    expect(isEditable(item)).toBe(false)
    let frozen = updateFinding(outcome.session, item.id, (finding) => ({
      ...finding,
      summary: "Diverged",
    }))
    frozen = discardFinding(frozen, item.id)
    expect(frozen).toEqual(outcome.session)

    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.attachmentsJSON)
    transport.enqueue(fixtures.appliedTagJSON)
    transport.enqueue(fixtures.appliedTypeTagJSON)

    const second = await fileAll(outcome.session, fixtures.filing(transport))

    expect(second.failure).toBeUndefined()
    expect(filedIssues(second.session)).toEqual([fixtures.filedIssue("RM-421")])
    expect(transport.urls).toEqual([
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.createIssue,
      urls.attachments("3-505"), // failed
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.attachments("3-505"),
      urls.tags("3-505"),
      urls.tags("3-505"),
    ])
  })

  test("a failure at tag application resumes at the tag alone — attachments are never re-uploaded", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.createdIssue421)
    transport.enqueue(fixtures.attachmentsJSON)
    transport.enqueueError(new TypeError("network connection lost"))

    const outcome = await fileAll(
      fixtures.sessionWith(["Solo"]),
      fixtures.filing(transport)
    )

    expect(outcome.failure).toBeInstanceOf(TypeError)
    expect(outcome.session.tray[0].filingProgress).toEqual({
      state: "attachmentsUploaded",
      issueID: "3-505",
      idReadable: "RM-421",
    })

    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.appliedTagJSON)
    transport.enqueue(fixtures.appliedTypeTagJSON)

    const second = await fileAll(outcome.session, fixtures.filing(transport))

    expect(second.failure).toBeUndefined()
    expect(filedIssues(second.session)).toEqual([fixtures.filedIssue("RM-421")])
    expect(transport.urls).toEqual([
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.createIssue,
      urls.attachments("3-505"),
      urls.tags("3-505"), // design-review, failed
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.tags("3-505"), // design-review
      urls.tags("3-505"), // Type
    ])
  })

  test("a failure at the Type tag resumes at that tag alone — the issue, attachments, and design-review tag are never redone", async () => {
    const transport = new FakeHTTPTransport()
    // Everything through the design-review tag succeeds; the Type tag POST
    // dies, and the item rests at reviewTagged, one rung short.
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.createdIssue421)
    transport.enqueue(fixtures.attachmentsJSON)
    transport.enqueue(fixtures.appliedTagJSON)
    transport.enqueueError(new TypeError("network connection lost"))

    const outcome = await fileAll(
      fixtures.sessionWith(["Solo"]),
      fixtures.filing(transport)
    )

    expect(outcome.failure).toBeInstanceOf(TypeError)
    expect(outcome.session.tray[0].filingProgress).toEqual({
      state: "reviewTagged",
      issueID: "3-505",
      idReadable: "RM-421",
    })
    expect(filedIssueOf(outcome.session.tray[0])).toBeUndefined()

    // The retry applies the Type tag alone: no re-created Issue, no
    // re-uploaded attachments, no re-applied design-review tag.
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(fixtures.appliedTypeTagJSON)

    const second = await fileAll(outcome.session, fixtures.filing(transport))

    expect(second.failure).toBeUndefined()
    expect(filedIssues(second.session)).toEqual([fixtures.filedIssue("RM-421")])
    expect(transport.urls).toEqual([
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.createIssue,
      urls.attachments("3-505"),
      urls.tags("3-505"), // design-review
      urls.tags("3-505"), // Type, failed
      urls.designReviewLookup,
      urls.bugTypeLookup,
      urls.tags("3-505"), // Type
    ])
  })

  // Pre-flight

  test("a summary-less Finding stops file-all before the first request — never a half-filed tray", async () => {
    const transport = new FakeHTTPTransport()
    const session = fixtures.sessionWith(["Fine", "  \n"])

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect((outcome.failure as YouTrackError).failure).toEqual({
      kind: "summaryRequired",
    })
    expect(outcome.session).toBe(session)
    expect(outcome.session.tray.every(isEditable)).toBe(true)
    expect(transport.sentRequests).toEqual([])
  })

  test("file-all with nothing left to file touches nothing", async () => {
    const transport = new FakeHTTPTransport()

    const outcome = await fileAll(fixtures.session, fixtures.filing(transport))

    expect(outcome.failure).toBeUndefined()
    expect(outcome.session).toBe(fixtures.session)
    expect(transport.sentRequests).toEqual([])
  })

  // Not in the Swift suite: IssueFiling.swift's comment that a mixed Bug and
  // Improvement run resolves each Type's tag once, in a stable order.
  test("a mixed Bug and Improvement run looks each Type tag up once, in name order, and applies each Finding's own", async () => {
    const transport = new FakeHTTPTransport()
    let session = addFinding(
      fixtures.session,
      fixtures.finding({
        summary: "Spacing could breathe",
        type: "improvement",
      })
    ).session
    session = addFinding(
      session,
      fixtures.finding({ summary: "Wrong red" })
    ).session
    transport.enqueue(fixtures.existingTagJSON)
    transport.enqueue(fixtures.existingTypeTagJSON)
    transport.enqueue(`[{"id":"6-6","name":"nitpick-type:improvement"}]`)
    transport.enqueue(fixtures.createdIssue421)
    transport.enqueue(fixtures.attachmentsJSON)
    transport.enqueue(fixtures.appliedTagJSON)
    transport.enqueue(`{"id":"6-6","name":"nitpick-type:improvement"}`)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBeUndefined()
    expect(transport.urls.slice(0, 3)).toEqual([
      urls.designReviewLookup,
      urls.bugTypeLookup,
      `${fixtures.base}/api/tags?fields=id,name&query=nitpick-type:improvement&$top=100`,
    ])
    const typeTags = transport.sentRequests
      .filter((request) => request.url.endsWith("/tags?fields=id,name"))
      .map(bodyText)
      .filter((body) => body !== `{"id":"6-4"}`)
    expect(typeTags).toEqual([`{"id":"6-6"}`, `{"id":"6-5"}`])
  })
})
