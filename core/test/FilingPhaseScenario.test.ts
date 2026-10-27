// Ports Tests/NitpickCoreTests/FilingPhaseScenarioTests.swift: the filing
// phase is a pure derivation of the Tray plus the shell's run facts. Core
// says what the marks mean; the shell knows whether a run is still going or
// stopped on a failure.
import { describe, expect, test } from "vitest"
import { filingPhase } from "../src/filingPhase.ts"
import { fileAll } from "../src/issueFiling.ts"
import { filedIssueOf, filedIssues, isEditable } from "../src/reviewSession.ts"
import type { ReviewSession } from "../src/reviewSession.ts"
import { FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

describe("Filing phase derivation", () => {
  test("an unfiled-only tray is idle with the correct count", () => {
    const session = fixtures.sessionWith(["One untouched finding"])

    expect(
      filingPhase(session, { isRunning: false, stoppedByFailure: false })
    ).toEqual({ phase: "idle", unfiled: 1 })
  })

  test("an empty tray is idle, never a vacuous done", () => {
    expect(
      filingPhase(fixtures.session, {
        isRunning: false,
        stoppedByFailure: false,
      })
    ).toEqual({ phase: "idle", unfiled: 0 })
  })

  test("mid-run progress reports the real acknowledged count over the whole tray", async () => {
    const transport = new FakeHTTPTransport()
    const session = fixtures.sessionWith(["First", "Second", "Third"])
    const progress: ReviewSession[] = []
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    transport.enqueueError(new TypeError("network connection lost"))

    const outcome = await fileAll(session, {
      ...fixtures.filing(transport),
      onProgress: (updated) => progress.push(updated),
    })

    expect(progress).toHaveLength(2)
    expect(
      filingPhase(progress[0], { isRunning: true, stoppedByFailure: false })
    ).toEqual({ phase: "filing", completed: 1, total: 3 })
    expect(
      filingPhase(progress[1], { isRunning: true, stoppedByFailure: false })
    ).toEqual({ phase: "filing", completed: 2, total: 3 })
    expect(
      filingPhase(outcome.session, { isRunning: false, stoppedByFailure: true })
    ).toEqual({ phase: "remaining", unfiled: 1 })
  })

  test("a failed run leaves the acked marks standing and reports the remaining work", async () => {
    const transport = new FakeHTTPTransport()
    const session = fixtures.sessionWith(["First", "Second", "Third"])
    const timedOut = new TypeError("timed out")
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    transport.enqueueError(timedOut)

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBe(timedOut)
    expect(filedIssueOf(outcome.session.tray[0])).toEqual(
      fixtures.filedIssue("RM-421")
    )
    expect(isEditable(outcome.session.tray[1])).toBe(true)
    expect(isEditable(outcome.session.tray[2])).toBe(true)
    expect(
      filingPhase(outcome.session, { isRunning: false, stoppedByFailure: true })
    ).toEqual({ phase: "remaining", unfiled: 2 })
  })

  test("a fully filed session is done because nothing remains unfiled", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)

    const outcome = await fileAll(
      fixtures.sessionWith(["Solo"]),
      fixtures.filing(transport)
    )

    expect(outcome.failure).toBeUndefined()
    expect(
      filingPhase(outcome.session, {
        isRunning: false,
        stoppedByFailure: false,
      })
    ).toEqual({ phase: "allFiled", count: 1 })
  })

  test("progress observation fires once per newly-filed item and stops when the run fails", async () => {
    const transport = new FakeHTTPTransport()
    const progress: number[] = []
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    transport.enqueueError(new TypeError("network connection lost"))

    const outcome = await fileAll(
      fixtures.sessionWith(["First", "Second", "Third"]),
      {
        ...fixtures.filing(transport),
        onProgress: (updated) => progress.push(filedIssues(updated).length),
      }
    )

    expect(outcome.failure).toBeInstanceOf(TypeError)
    expect(progress).toEqual([1, 2])
    expect(
      filingPhase(outcome.session, { isRunning: false, stoppedByFailure: true })
    ).toEqual({ phase: "remaining", unfiled: 1 })
  })
})
