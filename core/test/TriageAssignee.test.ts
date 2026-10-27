// Ports Tests/NitpickCoreTests/TriageAssigneeTests.swift: the assignable
// users read alongside the Priority scale, Assignee as a native user custom
// field on the create body, and the shared retry without the optional fields
// (ADR-0008).
import { describe, expect, test } from "vitest"
import { fileAll } from "../src/issueFiling.ts"
import { loadProjectSchema } from "../src/projectSchema.ts"
import { addFinding, filedIssueOf, type Finding } from "../src/reviewSession.ts"
import type { FindingAssignee } from "../src/triage.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

/**
 * A project schema with an Assignee user bundle and a Priority enum bundle:
 * the read pulls both in one request.
 */
const assigneeSchemaJSON = `[
  {"field":{"name":"Priority"},"bundle":{"values":[{"name":"Critical"}]}},
  {"field":{"name":"Assignee"},"bundle":{"aggregatedUsers":[
    {"login":"vera","fullName":"Vera Baumann"},
    {"login":"jonas","fullName":"Jonas Frei"}
  ]}}
]`

const vera: FindingAssignee = { login: "vera", fullName: "Vera Baumann" }

const priorityField = `{"$type":"SingleEnumIssueCustomField","name":"Priority","value":{"name":"Critical"}}`
const assigneeField = `{"$type":"SingleUserIssueCustomField","name":"Assignee","value":{"login":"vera"}}`

function assigneeFinding(assignee: FindingAssignee = vera): Finding {
  return { ...fixtures.finding(), assignee }
}

async function fileOne(transport: FakeHTTPTransport, finding: Finding) {
  const { session, id } = addFinding(fixtures.session, finding)
  return { id, outcome: await fileAll(session, fixtures.filing(transport)) }
}

describe("Triage — Assignee", () => {
  // Session-start users read

  test("session setup reads the project's assignable users alongside the Priority scale", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(assigneeSchemaJSON)

    const schema = await loadProjectSchema(
      fixtures.youTrack(transport),
      fixtures.session.project
    )

    expect(schema.assignees).toEqual([
      { login: "vera", fullName: "Vera Baumann" },
      { login: "jonas", fullName: "Jonas Frei" },
    ])
    // The same read also carried the Priority scale: one request.
    expect(schema.priorities).toEqual([{ name: "Critical" }])
    expect(transport.sentRequests).toHaveLength(1)
  })

  test("a project with no assignable users yields an empty list; the read stays non-fatal", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(
      `[{"field":{"name":"Priority"},"bundle":{"values":[{"name":"Critical"}]}}]`
    )

    const schema = await loadProjectSchema(
      fixtures.youTrack(transport),
      fixtures.session.project
    )

    expect(schema.assignees).toEqual([])
    expect(schema.priorities).toEqual([{ name: "Critical" }])
  })

  // Not in the Swift suite: BundleUser's doc comment, a user without a full
  // name is shown by login, and one without a login is skipped.
  test("an assignable user without a full name is shown by login; one without a login is left out", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(
      `[{"field":{"name":"Assignee"},"bundle":{"aggregatedUsers":[{"login":"jonas","fullName":null},{"fullName":"Nobody"}]}}]`
    )

    const schema = await loadProjectSchema(
      fixtures.youTrack(transport),
      fixtures.session.project
    )

    expect(schema.assignees).toEqual([{ login: "jonas", fullName: "jonas" }])
  })

  // Filing translation

  test("Assignee rides the create body as a native user custom field, by login", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)

    const { outcome } = await fileOne(transport, assigneeFinding())

    expect(outcome.droppedFields).toEqual({})
    expect(bodyText(transport.sentRequests[2])).toBe(
      `{"customFields":[${assigneeField}],${fixtures.expectedIssueJSON.slice(1)}`
    )
  })

  test("Priority and Assignee ride together, Priority first, so the body stays byte-stable", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)

    await fileOne(transport, {
      ...fixtures.finding(),
      priority: { name: "Critical" },
      assignee: vera,
    })

    expect(bodyText(transport.sentRequests[2])).toBe(
      `{"customFields":[${priorityField},${assigneeField}],${fixtures.expectedIssueJSON.slice(1)}`
    )
  })

  // Write-side degradation

  test("a rejected assignee retries without it; the Finding still files and the drop is reported with the full name", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"unknown user"}`, 400) // with field
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON) // without

    const { id, outcome } = await fileOne(transport, assigneeFinding())

    expect(filedIssueOf(outcome.session.tray[0])).toEqual(
      fixtures.filedIssue("RM-421")
    )
    expect(outcome.droppedFields).toEqual({
      [id]: [{ field: "assignee", intendedValue: "Vera Baumann" }],
    })
    // The retry drops the custom field entirely: the plain body returns.
    expect(bodyText(transport.sentRequests[3])).toBe(fixtures.expectedIssueJSON)
  })

  test("a create rejection drops every optional field together and reports each — Priority and Assignee both", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"bad custom fields"}`, 400)
    fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)

    const { id, outcome } = await fileOne(transport, {
      ...fixtures.finding(),
      priority: { name: "Critical" },
      assignee: vera,
    })

    expect(filedIssueOf(outcome.session.tray[0])).toEqual(
      fixtures.filedIssue("RM-421")
    )
    // Both were left out of the retry, so both are reported: nothing is
    // silently lost (ADR-0008: the whole optional set is dropped at once).
    expect(outcome.droppedFields).toEqual({
      [id]: [
        { field: "priority", intendedValue: "Critical" },
        { field: "assignee", intendedValue: "Vera Baumann" },
      ],
    })
    expect(bodyText(transport.sentRequests[3])).toBe(fixtures.expectedIssueJSON)
  })
})
