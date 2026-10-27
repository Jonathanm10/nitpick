// Ports Tests/NitpickCoreTests/FindingsNeedingSummaryTests.swift.
import { describe, expect, test } from "vitest"
import {
  addFinding,
  findingsNeedingSummary,
  updateFinding,
  type ReviewSession,
} from "../src/reviewSession.ts"
import * as fixtures from "./fixtures.ts"

/** FilingPhaseScenarioTests.session: one Finding per summary. */
function sessionWith(summaries: string[]): ReviewSession {
  return summaries.reduce(
    (session, summary) =>
      addFinding(session, fixtures.finding({ summary })).session,
    fixtures.session
  )
}

describe("Findings needing a summary", () => {
  test("blank and whitespace-only summaries block, in tray order", () => {
    const titled = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Titled" })
    )
    const untitled = addFinding(
      titled.session,
      fixtures.finding({ summary: "" })
    )
    const alsoTitled = addFinding(
      untitled.session,
      fixtures.finding({ summary: "Also titled" })
    )
    const whitespace = addFinding(
      alsoTitled.session,
      fixtures.finding({ summary: "  \n" })
    )

    expect(findingsNeedingSummary(whitespace.session)).toEqual([
      untitled.id,
      whitespace.id,
    ])
  })

  test("a fully summarized tray has nothing blocking it", () => {
    expect(findingsNeedingSummary(sessionWith(["One", "Two"]))).toEqual([])
  })

  test("typing a summary unblocks the Finding", () => {
    const { session, id } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "" })
    )
    expect(findingsNeedingSummary(session)).toEqual([id])

    const summarized = updateFinding(session, id, (finding) => ({
      ...finding,
      summary: "Now it has one",
    }))

    expect(findingsNeedingSummary(summarized)).toEqual([])
  })

  test("a filed Finding never blocks; only the untitled capture after it does", () => {
    const solo = sessionWith(["Solo"])
    const filed = fixtures.withFilingProgress(solo, solo.tray[0].id, {
      state: "filed",
      issue: fixtures.filedIssue("RM-421"),
    })

    const fresh = addFinding(filed, fixtures.finding({ summary: "" }))

    expect(findingsNeedingSummary(fresh.session)).toEqual([fresh.id])
  })
})
