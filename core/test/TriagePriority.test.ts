// Ports Tests/NitpickCoreTests/TriagePriorityTests.swift: the session-start
// schema read, Priority as a native custom field on the create body, the
// retry once without it when the create is rejected, and the dropped-field
// report (ADR-0008).
import { describe, expect, test } from "vitest"
import { fileAll } from "../src/issueFiling.ts"
import { loadProjectSchema } from "../src/projectSchema.ts"
import { addFinding, filedIssueOf, type Finding } from "../src/reviewSession.ts"
import { YouTrackError } from "../src/youtrack.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

/**
 * A project schema response: a Priority enum bundle plus an unrelated bundle
 * field, in the project's own order.
 */
const prioritySchemaJSON = `[
  {"field":{"name":"State"},"bundle":{"values":[{"name":"Open"},{"name":"Fixed"}]}},
  {"field":{"name":"Priority"},"bundle":{"values":[{"name":"Show-stopper"},{"name":"Critical"},{"name":"Normal"}]}}
]`

function priorityFinding(name = "Critical"): Finding {
  return { ...fixtures.finding(), priority: { name } }
}

/**
 * The create body a Priority-carrying Finding files: the custom field, then
 * the description, project and summary the plain filing sends.
 */
function expectedBody(priority: string): string {
  return `{"customFields":[{"$type":"SingleEnumIssueCustomField","name":"Priority","value":{"name":"${priority}"}}],${fixtures.expectedIssueJSON.slice(1)}`
}

describe("Triage — Priority", () => {
  // Session-start schema read

  test("session setup reads the project's Priority scale in project order, with the exact request shape", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(prioritySchemaJSON)

    const schema = await loadProjectSchema(
      fixtures.youTrack(transport),
      fixtures.session.project
    )

    expect(schema.priorities).toEqual([
      { name: "Show-stopper" },
      { name: "Critical" },
      { name: "Normal" },
    ])
    expect(transport.sentRequests).toEqual([
      {
        method: "GET",
        url: `${fixtures.base}/api/admin/projects/0-12/customFields?fields=field(name),bundle(values(name),aggregatedUsers(login,fullName))&$top=100`,
        headers: fixtures.expectedHeaders,
      },
    ])
  })

  test("a failed schema read is non-fatal: an empty scale, no error surfaced", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(`{"error":"Forbidden"}`, 403)

    const schema = await loadProjectSchema(
      fixtures.youTrack(transport),
      fixtures.session.project
    )

    expect(schema.priorities).toEqual([])
  })

  test("a project with no Priority field yields an empty scale", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(
      `[{"field":{"name":"State"},"bundle":{"values":[{"name":"Open"}]}}]`
    )

    const schema = await loadProjectSchema(
      fixtures.youTrack(transport),
      fixtures.session.project
    )

    expect(schema.priorities).toEqual([])
  })

  // Not in the Swift suite: the other failures its doc comment names.
  test("an offline or unreadable schema read is non-fatal too", async () => {
    const offline = new FakeHTTPTransport()
    offline.enqueueError(new TypeError("fetch failed"))
    const garbled = new FakeHTTPTransport()
    garbled.enqueue(`{"field":"not a list"}`)

    for (const transport of [offline, garbled]) {
      expect(
        await loadProjectSchema(
          fixtures.youTrack(transport),
          fixtures.session.project
        )
      ).toEqual({ priorities: [], assignees: [] })
    }
  })

  // Filing translation

  test("Priority rides the create body as a native custom field; nothing else about filing changes", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)
    const { session } = addFinding(fixtures.session, priorityFinding())

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(filedIssueOf(outcome.session.tray[0])).toEqual(
      fixtures.filedIssue("RM-421")
    )
    expect(outcome.droppedFields).toEqual({})
    const creation = transport.sentRequests[2]
    expect(creation.url).toBe(fixtures.urls.createIssue)
    expect(bodyText(creation)).toBe(expectedBody("Critical"))
  })

  // Write-side degradation

  test("a create rejected for the field retries once without it — the Finding still files and the drop is reported", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"custom field rejected"}`, 400) // with field
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON) // without
    const { session, id } = addFinding(fixtures.session, priorityFinding())

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(filedIssueOf(outcome.session.tray[0])).toEqual(
      fixtures.filedIssue("RM-421")
    )
    expect(outcome.droppedFields).toEqual({
      [id]: [{ field: "priority", intendedValue: "Critical" }],
    })

    // design lookup, type lookup, create (with field, 400), create (without),
    // attach, design-review tag, Type tag.
    const requests = transport.sentRequests
    expect(requests).toHaveLength(7)
    expect(requests[2].url).toBe(fixtures.urls.createIssue)
    expect(requests[3].url).toBe(fixtures.urls.createIssue)
    expect(bodyText(requests[2])).toBe(expectedBody("Critical"))
    // The retry drops the custom field entirely: the plain body returns.
    expect(bodyText(requests[3])).toBe(fixtures.expectedIssueJSON)
  })

  test("a 403 on creation is a genuine failure — no field-dropping retry", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"Forbidden"}`, 403)
    const { session } = addFinding(fixtures.session, priorityFinding())

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect((outcome.failure as YouTrackError).failure).toEqual({
      kind: "permissionDenied",
      action: "create an issue in Review Me",
    })
    // No retry: design lookup, type lookup and the refused create.
    expect(transport.sentRequests).toHaveLength(3)
  })

  // Not in the Swift suite: its doc comment's "retried exactly once".
  test("a retry without the field that fails again propagates, and is not retried again", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"custom field rejected"}`, 400)
    transport.enqueue(`{"error":"still bad"}`, 400)
    const { session } = addFinding(fixtures.session, priorityFinding())

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect((outcome.failure as YouTrackError).failure).toEqual({
      kind: "unexpectedResponse",
      statusCode: 400,
    })
    expect(transport.sentRequests).toHaveLength(4)
    expect(outcome.session.tray[0].filingProgress).toEqual({
      state: "notStarted",
    })
  })

  // File all reporting

  test("file-all reports dropped fields keyed by tray item", async () => {
    const transport = new FakeHTTPTransport()
    const { session, id } = addFinding(fixtures.session, priorityFinding())
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"custom field rejected"}`, 400)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBeUndefined()
    expect(outcome.droppedFields).toEqual({
      [id]: [{ field: "priority", intendedValue: "Critical" }],
    })
  })
})
