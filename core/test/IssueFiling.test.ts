// Ports Tests/NitpickCoreTests/IssueFilingTests.swift: one Finding files as
// exactly one Issue, authored by the token's user, carrying summary,
// description and metadata block, both screenshots, and both tags. Asserts the
// exact requests: endpoint, JSON body bytes, multipart bytes.
//
// Swift's single-Finding `file(_:in:)` is called only by tests; the app files
// through `fileAll`. These cases run `fileAll` over a one-Finding Tray, which
// sends the same requests.
//
// Not ported: filing before connecting. Filing takes a YouTrackClient, so
// there is no unconnected call to make.
import { describe, expect, test } from "vitest"
import { fileAll } from "../src/issueFiling.ts"
import {
  addFinding,
  filedIssueOf,
  type Finding,
  type ReviewSession,
} from "../src/reviewSession.ts"
import { YouTrackError } from "../src/youtrack.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

const { base, urls } = fixtures

function single(finding: Finding, session: ReviewSession = fixtures.session) {
  return addFinding(session, finding)
}

function enqueueWholeLadder(transport: FakeHTTPTransport): void {
  fixtures.enqueueTagLookups(transport)
  fixtures.enqueueLadder(transport, fixtures.createdIssueJSON)
}

describe("Issue filing", () => {
  test("filing emits find-tag ×2 → create issue → attach both screenshots → apply both tags, with exact bodies", async () => {
    const transport = new FakeHTTPTransport()
    enqueueWholeLadder(transport)
    const { session, id } = single(fixtures.finding())

    const outcome = await fileAll(session, fixtures.filing(transport))

    expect(outcome.failure).toBeUndefined()
    expect(filedIssueOf(outcome.session.tray[0])).toEqual({
      idReadable: "RM-421",
      url: "https://youtrack.example.com/yt/issue/RM-421",
    })
    expect(outcome.droppedFields).toEqual({})
    expect(outcome.session.tray[0].id).toBe(id)

    const requests = transport.sentRequests
    expect(requests).toHaveLength(6)
    for (const request of requests) {
      expect(request.headers.Authorization).toBe(`Bearer ${fixtures.token}`)
      expect(request.headers.Accept).toBe("application/json")
    }

    // 1. Both tags are looked up by name, before any Issue exists: the fixed
    //    design-review tag, then the Finding's Type tag.
    expect(requests[0]).toEqual({
      method: "GET",
      url: `${base}/api/tags?fields=id,name&query=design-review&$top=100`,
      headers: fixtures.expectedHeaders,
    })
    expect(requests[1]).toEqual({
      method: "GET",
      url: `${base}/api/tags?fields=id,name&query=nitpick-type:bug&$top=100`,
      headers: fixtures.expectedHeaders,
    })

    // 2. Exactly one Issue is created: summary + description with the
    //    metadata block appended, in the session's project.
    expect(requests[2].method).toBe("POST")
    expect(requests[2].url).toBe(`${base}/api/issues?fields=id,idReadable`)
    expect(requests[2].headers["Content-Type"]).toBe("application/json")
    expect(bodyText(requests[2])).toBe(fixtures.expectedIssueJSON)

    // 3. Both screenshots ride one multipart request: the annotated variant
    //    first, the clean original second. Unannotated, the annotated variant
    //    is the original bytes.
    expect(requests[3].method).toBe("POST")
    expect(requests[3].url).toBe(
      `${base}/api/issues/3-505/attachments?fields=id,name`
    )
    expect(requests[3].body).toEqual(
      fixtures.multipartBody(fixtures.boundaryOf(requests[3]), [
        { fileName: "annotated.png", data: fixtures.pngBytes },
        { fileName: "original.png", data: fixtures.pngBytes },
      ])
    )

    // 4. The design-review tag is applied first, then the Type tag, each by
    //    ID, one tag per request.
    expect(requests[4].method).toBe("POST")
    expect(requests[4].url).toBe(`${base}/api/issues/3-505/tags?fields=id,name`)
    expect(requests[4].headers["Content-Type"]).toBe("application/json")
    expect(bodyText(requests[4])).toBe(`{"id":"6-4"}`)
    expect(requests[5].method).toBe("POST")
    expect(requests[5].url).toBe(`${base}/api/issues/3-505/tags?fields=id,name`)
    expect(bodyText(requests[5])).toBe(`{"id":"6-5"}`)
  })

  test("an annotated Finding attaches the flattened variant plus the untouched original", async () => {
    const transport = new FakeHTTPTransport()
    enqueueWholeLadder(transport)
    const annotated: Finding = {
      ...fixtures.finding({ description: "" }),
      annotations: [
        {
          kind: "rectangle",
          color: "red",
          rect: { x: 60, y: 500, width: 240, height: 160 },
        },
      ],
    }
    const { session } = single(annotated)

    await fileAll(session, fixtures.filing(transport))

    const flattened = await fixtures.fakeFlatten(
      fixtures.pngBytes,
      annotated.annotations
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

  test("a flattening failure aborts before any issue exists — no orphans", async () => {
    const transport = new FakeHTTPTransport()
    const unreadable = new Error("The capture could not be read as an image.")
    const { session } = single({
      ...fixtures.finding(),
      annotations: [
        {
          kind: "rectangle",
          color: "red",
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
      ],
    })

    const outcome = await fileAll(session, {
      ...fixtures.filing(transport),
      flatten: async () => {
        throw unreadable
      },
    })

    expect(outcome.failure).toBe(unreadable)
    expect(transport.sentRequests).toEqual([])
  })

  test("a missing design-review tag is created on first use, before the issue", async () => {
    const transport = new FakeHTTPTransport()
    // The lookup finds only a lookalike; exact-name matching rejects it and
    // the tag is created before the Issue. The Type tag already exists, so
    // its lookup is a single GET.
    transport.enqueue(
      `[{"id":"6-9","name":"design-review-2024","$type":"Tag"}]`
    )
    transport.enqueue(`{"id":"6-77","name":"design-review","$type":"Tag"}`)
    transport.enqueue(fixtures.existingTypeTagJSON)
    transport.enqueue(fixtures.createdIssueJSON)
    transport.enqueue(fixtures.attachmentsJSON)
    transport.enqueue(`{"id":"6-77","name":"design-review","$type":"Tag"}`)
    transport.enqueue(fixtures.appliedTypeTagJSON)

    await fileAll(
      single(fixtures.finding()).session,
      fixtures.filing(transport)
    )

    const requests = transport.sentRequests
    expect(requests).toHaveLength(7)
    expect(requests[1].method).toBe("POST")
    expect(requests[1].url).toBe(`${base}/api/tags?fields=id,name`)
    expect(bodyText(requests[1])).toBe(`{"name":"design-review"}`)
    // The freshly created tag's ID is the one applied.
    expect(bodyText(requests[5])).toBe(`{"id":"6-77"}`)
  })

  test("an empty description files the metadata block alone — no leading blank lines", async () => {
    const transport = new FakeHTTPTransport()
    enqueueWholeLadder(transport)

    await fileAll(
      single(fixtures.finding({ description: "  \n" })).session,
      fixtures.filing(transport)
    )

    expect(bodyText(transport.sentRequests[2])).toBe(
      String.raw`{"description":"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n` +
        String.raw`Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}`
    )
  })

  test("a session-level Design Reference lands in every filed issue; a Finding's own overrides it", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    fixtures.enqueueLadder(transport, fixtures.createdIssue421)
    fixtures.enqueueLadder(transport, fixtures.createdIssue422)
    let session: ReviewSession = {
      ...fixtures.session,
      designReference: "https://www.figma.com/file/sess42/ReviewMe",
    }
    session = single(fixtures.finding(), session).session
    session = single(
      {
        ...fixtures.finding(),
        designReference: "https://www.figma.com/file/abc123/ReviewMe",
      },
      session
    ).session

    await fileAll(session, fixtures.filing(transport))

    const bodies = transport.sentRequests
      .filter((request) => request.url === urls.createIssue)
      .map(bodyText)
    const designLine = (url: string) =>
      String.raw`{"description":"The primary button is #FF0000, the design says #E64545.\n\n` +
      String.raw`---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n` +
      String.raw`Design: ${url}\n` +
      String.raw`Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}`
    expect(bodies).toEqual([
      designLine("https://www.figma.com/file/sess42/ReviewMe"),
      designLine("https://www.figma.com/file/abc123/ReviewMe"),
    ])
  })

  test("a blank summary never reaches the network", async () => {
    const transport = new FakeHTTPTransport()

    const outcome = await fileAll(
      single(fixtures.finding({ summary: "  \n" })).session,
      fixtures.filing(transport)
    )

    expect(outcome.failure).toEqual(
      new YouTrackError({ kind: "summaryRequired" })
    )
    expect(transport.sentRequests).toEqual([])
  })

  test("a 403 on issue creation names the missing permission, not the token", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"Forbidden"}`, 403)

    const outcome = await fileAll(
      single(fixtures.finding()).session,
      fixtures.filing(transport)
    )

    expect(outcome.failure).toBeInstanceOf(YouTrackError)
    expect((outcome.failure as YouTrackError).failure).toEqual({
      kind: "permissionDenied",
      action: "create an issue in Review Me",
    })
    // Nothing after the refused creation: no attach, no tagging.
    expect(transport.sentRequests).toHaveLength(3)
  })

  test("a creation failure propagates — the required-custom-fields signal, not a crash", async () => {
    const transport = new FakeHTTPTransport()
    fixtures.enqueueTagLookups(transport)
    transport.enqueue(`{"error":"Bad Request"}`, 400)

    const outcome = await fileAll(
      single(fixtures.finding()).session,
      fixtures.filing(transport)
    )

    expect((outcome.failure as YouTrackError).failure).toEqual({
      kind: "unexpectedResponse",
      statusCode: 400,
    })
    expect(transport.sentRequests).toHaveLength(3)
  })

  test("filing errors speak to the designer", () => {
    expect(new YouTrackError({ kind: "notConnected" }).message).toBe(
      "Connect to YouTrack (instance URL + permanent token) before filing."
    )
    expect(new YouTrackError({ kind: "summaryRequired" }).message).toBe(
      "The Finding needs a summary before it can be filed."
    )
    expect(
      new YouTrackError({
        kind: "permissionDenied",
        action: "create an issue in Review Me",
      }).message
    ).toBe(
      "YouTrack denied permission to create an issue in Review Me. Ask a YouTrack administrator about your access."
    )
  })

  // Not in the Swift suite: the acceptance criterion that every HTTP failure
  // of a filing step reads as today's message, step by step.
  test.each([
    {
      failingRequest: 0,
      status: 403,
      message:
        "YouTrack denied permission to list tags. Ask a YouTrack administrator about your access.",
    },
    {
      failingRequest: 2,
      status: 403,
      message:
        "YouTrack denied permission to create an issue in Review Me. Ask a YouTrack administrator about your access.",
    },
    {
      failingRequest: 3,
      status: 403,
      message:
        "YouTrack denied permission to attach the screenshots. Ask a YouTrack administrator about your access.",
    },
    {
      failingRequest: 4,
      status: 403,
      message:
        "YouTrack denied permission to apply the “design-review” tag. Ask a YouTrack administrator about your access.",
    },
    {
      failingRequest: 5,
      status: 403,
      message:
        "YouTrack denied permission to apply the “nitpick-type:bug” tag. Ask a YouTrack administrator about your access.",
    },
    ...[0, 1, 2, 3, 4, 5].map((failingRequest) => ({
      failingRequest,
      status: 401,
      message:
        "YouTrack rejected the token. Check that the permanent token was pasted completely and is still valid.",
    })),
    ...[404, 500, 502].map((status) => ({
      failingRequest: 3,
      status,
      message: `YouTrack answered with HTTP ${status}. Check the instance URL, or try again later.`,
    })),
  ])(
    "HTTP $status on request $failingRequest reads: $message",
    async ({ failingRequest, status, message }) => {
      const transport = new FakeHTTPTransport()
      const ladder = [
        fixtures.existingTagJSON,
        fixtures.existingTypeTagJSON,
        fixtures.createdIssueJSON,
        fixtures.attachmentsJSON,
        fixtures.appliedTagJSON,
        fixtures.appliedTypeTagJSON,
      ]
      for (const json of ladder.slice(0, failingRequest))
        transport.enqueue(json)
      transport.enqueue(`{"error":"nope"}`, status)

      const outcome = await fileAll(
        single(fixtures.finding()).session,
        fixtures.filing(transport)
      )

      expect(outcome.failure).toBeInstanceOf(YouTrackError)
      expect((outcome.failure as Error).message).toBe(message)
      expect(transport.sentRequests).toHaveLength(failingRequest + 1)
    }
  )

  test("a 403 on creating a missing tag names that tag", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue("[]")
    transport.enqueue(`{"error":"Forbidden"}`, 403)

    const outcome = await fileAll(
      single(fixtures.finding()).session,
      fixtures.filing(transport)
    )

    expect((outcome.failure as Error).message).toBe(
      "YouTrack denied permission to create the “design-review” tag (it does not exist yet). Ask a YouTrack administrator about your access."
    )
  })
})
