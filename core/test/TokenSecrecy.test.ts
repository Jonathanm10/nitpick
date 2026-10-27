// Not a Swift port: issue 05's acceptance criterion that the token never
// appears in logs, errors or test output. The token rides only the
// Authorization header the transport sends; the credentials hold it in a
// private field, so logging them, or anything holding them, prints none of
// it, and no error or outcome core produces carries it.
import { inspect } from "node:util"
import { describe, expect, test } from "vitest"
import { sendFeedback } from "../src/feedback.ts"
import { fileAll } from "../src/issueFiling.ts"
import { loadProjectSchema } from "../src/projectSchema.ts"
import { addFinding } from "../src/reviewSession.ts"
import {
  verifyYouTrack,
  YouTrackClient,
  YouTrackCredentials,
} from "../src/youtrack.ts"
import { FakeFilingStore } from "./FakeFilingStore.ts"
import { FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import * as fixtures from "./fixtures.ts"

// Long and distinctive, so a leak can't hide behind a short fixture value,
// and plainly fictional, so no secret scanner mistakes it for a real one.
const token = "fictional-secrecy-test-token-6f1c2e9a"

function client(transport: FakeHTTPTransport): YouTrackClient {
  return new YouTrackClient(
    transport,
    new YouTrackCredentials(fixtures.base, ` ${token}\n`)
  )
}

/** Every way a value reaches a log line or a test failure message. */
function renderings(value: unknown): string[] {
  const renderings = [
    String(value),
    inspect(value, { depth: Infinity, showHidden: true, getters: true }),
    JSON.stringify(value) ?? "",
  ]
  if (value instanceof Error) {
    renderings.push(value.message, value.stack ?? "")
  }
  return renderings
}

function expectNoToken(value: unknown): void {
  for (const rendering of renderings(value)) {
    expect(rendering.includes(token), rendering).toBe(false)
    expect(rendering.includes("6f1c2e9a"), rendering).toBe(false)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection")
    },
    (error: unknown) => error
  )
}

const failingResponses: ReadonlyArray<(transport: FakeHTTPTransport) => void> =
  [
    (transport) => transport.enqueue(`{"error":"Unauthorized"}`, 401),
    (transport) => transport.enqueue(`{"error":"Forbidden"}`, 403),
    (transport) => transport.enqueue(`{"error":"Not Found"}`, 404),
    (transport) => transport.enqueue(`{"error":"Bad Request"}`, 400),
    (transport) => transport.enqueue(`{"error":"boom"}`, 500),
    (transport) => transport.enqueue("<html>not YouTrack</html>"),
  ]

describe("Token secrecy", () => {
  test("the credentials and the client never render the token", () => {
    const transport = new FakeHTTPTransport()
    const youTrack = client(transport)

    expectNoToken(youTrack.credentials)
    expectNoToken(youTrack)
    expect(JSON.stringify(youTrack.credentials)).toBe(
      `{"instanceURL":"${fixtures.base}"}`
    )
  })

  test("the token is trimmed and sent only in the Authorization header", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(fixtures.userJSON)
    transport.enqueue("[]")

    await verifyYouTrack(client(transport))

    for (const request of transport.sentRequests) {
      expect(request.headers.Authorization).toBe(`Bearer ${token}`)
      expect(request.url).not.toContain(token)
      expectNoToken(
        Object.entries(request.headers).filter(
          ([name]) => name !== "Authorization"
        )
      )
    }
  })

  test("no connection error carries the token", async () => {
    for (const fail of failingResponses) {
      const transport = new FakeHTTPTransport()
      fail(transport)
      expectNoToken(await rejection(verifyYouTrack(client(transport))))
    }
    for (const entered of ["", "not a url", "http://yt.example.com"]) {
      let thrown: unknown
      try {
        new YouTrackCredentials(entered, token)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expectNoToken(thrown)
    }
  })

  test("a non-fatal schema read swallows its failures without them reaching anything", async () => {
    for (const fail of failingResponses) {
      const transport = new FakeHTTPTransport()
      fail(transport)
      expectNoToken(
        await loadProjectSchema(client(transport), fixtures.session.project)
      )
    }
  })

  test("no filing failure or outcome carries the token, at any rung", async () => {
    const ladder = [
      fixtures.existingTagJSON,
      fixtures.existingTypeTagJSON,
      fixtures.createdIssueJSON,
      fixtures.attachmentsJSON,
      fixtures.appliedTagJSON,
      fixtures.appliedTypeTagJSON,
    ]
    const { session } = addFinding(fixtures.session, {
      ...fixtures.finding(),
      priority: { name: "Critical" },
    })
    for (let failing = 0; failing < ladder.length; failing++) {
      for (const fail of failingResponses) {
        const transport = new FakeHTTPTransport()
        for (const json of ladder.slice(0, failing)) transport.enqueue(json)
        fail(transport)
        const outcome = await fileAll(session, {
          youTrack: client(transport),
          store: new FakeFilingStore(fixtures.pngBytes),
          flatten: fixtures.fakeFlatten,
        })
        expect(outcome.failure).toBeDefined()
        expectNoToken(outcome)
        expectNoToken(outcome.failure)
      }
    }
  })

  test("no Feedback failure or warning carries the token", async () => {
    const feedbackLadder = [
      `{"id":"0-77","name":"Nitpick"}`,
      `[{"id":"6-3910","name":"nitpick-feedback:bug"}]`,
      `{"id":"3-900","idReadable":"NIT-42"}`,
      `{"id":"6-3910","name":"nitpick-feedback:bug"}`,
    ]
    const feedback = {
      kind: "bug" as const,
      title: "Tray loses focus",
      description: "",
      environment: { nitpick: "unknown", macOS: "26.1", xcode: "unknown" },
      imagePNG: fixtures.pngBytes,
    }
    for (let failing = 0; failing <= feedbackLadder.length; failing++) {
      for (const fail of failingResponses) {
        const transport = new FakeHTTPTransport()
        for (const json of feedbackLadder.slice(0, failing)) {
          transport.enqueue(json)
        }
        fail(transport)
        const result = await sendFeedback(feedback, {
          youTrack: client(transport),
          flatten: fixtures.fakeFlatten,
        }).catch((error: unknown) => error)
        expectNoToken(result)
      }
    }
  })
})
