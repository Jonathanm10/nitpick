// Not a Swift port: pins issue 05's acceptance criteria for the filing ladder
// over every rung, where the Swift suite checks one rung per case
// (SessionTrayScenarioTests, DurabilityTests). Each acknowledged step is saved
// before the next request, and a ladder interrupted at any request resumes
// without repeating an acknowledged one, both in the same run's session and
// from the last save after a restart.
import { describe, expect, test } from "vitest"
import type { HTTPRequest } from "../src/http.ts"
import { fileAll } from "../src/issueFiling.ts"
import {
  addFinding,
  filedIssues,
  type FilingProgress,
  type ReviewSession,
} from "../src/reviewSession.ts"
import { FakeFilingStore } from "./FakeFilingStore.ts"
import { bodyText, FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

const { urls } = fixtures

/** Every response one Finding's ladder consumes, in order. */
const ladder = [
  fixtures.existingTagJSON,
  fixtures.existingTypeTagJSON,
  fixtures.createdIssueJSON,
  fixtures.attachmentsJSON,
  fixtures.appliedTagJSON,
  fixtures.appliedTypeTagJSON,
]

/** A request that changes the instance, named so a repeat is visible. */
function write(request: HTTPRequest): string | undefined {
  if (request.method !== "POST") return undefined
  return `${request.url} ${request.url.endsWith("/attachments?fields=id,name") ? "(files)" : bodyText(request)}`
}

function writes(transport: FakeHTTPTransport): string[] {
  return transport.sentRequests.flatMap((request) => write(request) ?? [])
}

/** One default Finding, whose create body is `expectedIssueJSON`. */
const solo = addFinding(fixtures.session, fixtures.finding()).session

/** The happy run's writes: create, attach, design-review tag, Type tag. */
const allWrites = [
  `${urls.createIssue} ${fixtures.expectedIssueJSON}`,
  `${urls.attachments("3-505")} (files)`,
  `${urls.tags("3-505")} {"id":"6-4"}`,
  `${urls.tags("3-505")} {"id":"6-5"}`,
]

describe("Filing ladder", () => {
  test("every acknowledged step is saved before the next request fires", async () => {
    const events: string[] = []
    const transport = new FakeHTTPTransport(events)
    const store = new FakeFilingStore(fixtures.pngBytes, events)
    for (const json of ladder) transport.enqueue(json)

    const outcome = await fileAll(solo, fixtures.filing(transport, store))

    expect(outcome.failure).toBeUndefined()
    expect(events).toEqual([
      // Typed text not yet on disk is saved before the first request.
      "save notStarted",
      `GET ${urls.designReviewLookup}`,
      `GET ${urls.bugTypeLookup}`,
      `POST ${urls.createIssue}`,
      "save issueCreated",
      `POST ${urls.attachments("3-505")}`,
      "save attachmentsUploaded",
      `POST ${urls.tags("3-505")}`,
      "save reviewTagged",
      `POST ${urls.tags("3-505")}`,
      "save filed",
      "history",
    ])
  })

  const failures = [
    {
      name: "a dropped connection",
      fail: (t: FakeHTTPTransport) =>
        t.enqueueError(new TypeError("network connection lost")),
    },
    {
      name: "HTTP 500",
      fail: (t: FakeHTTPTransport) => t.enqueue(`{"error":"boom"}`, 500),
    },
  ]

  describe.each(failures)("interrupted by $name", ({ fail }) => {
    test.each(ladder.map((_, index) => index))(
      "at request %i, a retry with the run's session repeats no acknowledged write",
      async (failingRequest) => {
        const transport = new FakeHTTPTransport()
        for (const json of ladder.slice(0, failingRequest))
          transport.enqueue(json)
        fail(transport)
        const first = await fileAll(solo, fixtures.filing(transport))
        expect(first.failure).toBeDefined()
        const acknowledged = writes(transport).slice(
          0,
          // The failed request is a write only from the create on.
          Math.max(0, failingRequest - 2)
        )

        const retryTransport = new FakeHTTPTransport()
        retryTransport.enqueue(fixtures.existingTagJSON)
        retryTransport.enqueue(fixtures.existingTypeTagJSON)
        for (const json of ladder.slice(Math.max(2, failingRequest))) {
          retryTransport.enqueue(json)
        }
        const retry = await fileAll(
          first.session,
          fixtures.filing(retryTransport)
        )

        expect(retry.failure).toBeUndefined()
        expect(filedIssues(retry.session)).toEqual([
          fixtures.filedIssue("RM-421"),
        ])
        expect([...acknowledged, ...writes(retryTransport)]).toEqual(allWrites)
      }
    )

    test.each(ladder.map((_, index) => index))(
      "at request %i, a restart that reads back the last save repeats no acknowledged write",
      async (failingRequest) => {
        const store = new FakeFilingStore(fixtures.pngBytes)
        const transport = new FakeHTTPTransport()
        for (const json of ladder.slice(0, failingRequest))
          transport.enqueue(json)
        fail(transport)
        await fileAll(solo, fixtures.filing(transport, store))
        const acknowledged = writes(transport).slice(
          0,
          Math.max(0, failingRequest - 2)
        )

        // Nothing in memory survives the restart.
        const resumed = store.loadOpenSession()
        if (resumed === undefined) throw new Error("the open session was lost")
        const retryTransport = new FakeHTTPTransport()
        retryTransport.enqueue(fixtures.existingTagJSON)
        retryTransport.enqueue(fixtures.existingTypeTagJSON)
        for (const json of ladder.slice(Math.max(2, failingRequest))) {
          retryTransport.enqueue(json)
        }
        const retry = await fileAll(
          resumed,
          fixtures.filing(retryTransport, store)
        )

        expect(retry.failure).toBeUndefined()
        expect([...acknowledged, ...writes(retryTransport)]).toEqual(allWrites)
        expect(store.sessionHistory()[0]?.findings[0]?.issue).toEqual(
          fixtures.filedIssue("RM-421")
        )
      }
    )
  })

  // A stored mark, from a crash or the Swift app's own open session, files
  // only the rungs after it.
  test.each([
    {
      mark: { state: "issueCreated", issueID: "3-505", idReadable: "RM-421" },
      remaining: allWrites.slice(1),
    },
    {
      mark: {
        state: "attachmentsUploaded",
        issueID: "3-505",
        idReadable: "RM-421",
      },
      remaining: allWrites.slice(2),
    },
    {
      mark: { state: "reviewTagged", issueID: "3-505", idReadable: "RM-421" },
      remaining: allWrites.slice(3),
    },
  ] satisfies ReadonlyArray<{ mark: FilingProgress; remaining: string[] }>)(
    "a stored $mark.state mark resumes at the next rung",
    async ({ mark, remaining }) => {
      const added = addFinding(fixtures.session, fixtures.finding())
      const session: ReviewSession = fixtures.withFilingProgress(
        added.session,
        added.id,
        mark
      )
      const transport = new FakeHTTPTransport()
      for (const json of [
        fixtures.existingTagJSON,
        fixtures.existingTypeTagJSON,
        ...ladder.slice(ladder.length - remaining.length),
      ]) {
        transport.enqueue(json)
      }

      const outcome = await fileAll(session, fixtures.filing(transport))

      expect(outcome.failure).toBeUndefined()
      expect(writes(transport)).toEqual(remaining)
      expect(filedIssues(outcome.session)).toEqual([
        fixtures.filedIssue("RM-421"),
      ])
    }
  )
})
