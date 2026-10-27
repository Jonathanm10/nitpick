// Ports the tray and pristine cases of
// Tests/NitpickCoreTests/SessionTrayScenarioTests.swift. Its file-all cases
// run the YouTrack filing ladder, which is issue 05's; where a case here
// needs a filing mark, it sets the mark the ladder would have recorded.
import { describe, expect, test } from "vitest"
import type { Annotation } from "../src/annotation.ts"
import {
  addFinding,
  discardFinding,
  filedIssues,
  hasUnfiledFindings,
  isEditable,
  isPristine,
  unfiledFindingCount,
  updateFinding,
  type ReviewSession,
  type TrayItem,
} from "../src/reviewSession.ts"
import * as fixtures from "./fixtures.ts"

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
