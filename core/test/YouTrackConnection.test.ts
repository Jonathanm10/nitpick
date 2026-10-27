// Ports Tests/NitpickCoreTests/YouTrackConnectionTests.swift: an instance URL
// and token are verified by fetching the connected user and the projects the
// Reviewer can file into, with the exact request shapes.
//
// Not ported: persisting the connection (the Keychain and youtrack.json), the
// relaunch that reads it back, and keeping the previous pair when a save
// fails. Where the server keeps a Reviewer's token is issue 10's; core only
// cleans up and verifies what it's given.
import { describe, expect, test } from "vitest"
import {
  verifyYouTrack,
  YouTrackClient,
  YouTrackCredentials,
  YouTrackError,
  type YouTrackConnection,
  type YouTrackFailure,
} from "../src/youtrack.ts"
import { FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import { expectedHeaders, projectsJSON, userJSON } from "./fixtures.ts"

const expectedConnection: YouTrackConnection = {
  user: { login: "vera", fullName: "Vera Baumann" },
  projects: [
    { id: "0-3", shortName: "ATL", name: "Atlas" },
    { id: "0-12", shortName: "RM", name: "Review Me" },
  ],
}

async function failureOf(promise: Promise<unknown>): Promise<YouTrackFailure> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  )
  expect(error).toBeInstanceOf(YouTrackError)
  return (error as YouTrackError).failure
}

function failureOfSync(attempt: () => unknown): YouTrackFailure {
  try {
    attempt()
  } catch (error) {
    expect(error).toBeInstanceOf(YouTrackError)
    return (error as YouTrackError).failure
  }
  throw new Error("expected a YouTrackError")
}

function verify(
  transport: FakeHTTPTransport,
  instanceURL: string,
  token = "perm:t"
): Promise<YouTrackConnection> {
  return verifyYouTrack(
    new YouTrackClient(transport, new YouTrackCredentials(instanceURL, token))
  )
}

describe("YouTrack connection scenario", () => {
  test("connect verifies user + projects with exact request shapes, and the saved credentials verify again after a relaunch", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(userJSON)
    transport.enqueue(projectsJSON)

    // First-run settings: the pasted URL and token arrive untidy.
    const credentials = new YouTrackCredentials(
      "youtrack.example.com/yt/",
      " perm:designer-token\n"
    )
    expect(credentials.instanceURL).toBe("https://youtrack.example.com/yt")
    const connection = await verifyYouTrack(
      new YouTrackClient(transport, credentials)
    )
    expect(connection).toEqual(expectedConnection)

    // The exact request shapes: identity first, then filable projects.
    expect(transport.sentRequests).toEqual([
      {
        method: "GET",
        url: "https://youtrack.example.com/yt/api/users/me?fields=login,fullName",
        headers: expectedHeaders,
      },
      {
        method: "GET",
        url: "https://youtrack.example.com/yt/api/admin/projects?fields=id,name,shortName&$top=100&$skip=0",
        headers: expectedHeaders,
      },
    ])
    for (const request of transport.sentRequests) {
      expect(request.body).toBeUndefined()
    }

    // Relaunch: the same credentials verify again with the same requests.
    const relaunchTransport = new FakeHTTPTransport()
    relaunchTransport.enqueue(userJSON)
    relaunchTransport.enqueue(projectsJSON)
    const resumed = await verifyYouTrack(
      new YouTrackClient(relaunchTransport, credentials)
    )
    expect(resumed).toEqual(expectedConnection)
    expect(relaunchTransport.sentRequests).toEqual(transport.sentRequests)
  })

  test("more projects than one page: every page is fetched and merged", async () => {
    const transport = new FakeHTTPTransport()
    // A full first page (100) means "maybe more"; the short second page (1)
    // ends the walk.
    const fullPage = Array.from(
      { length: 100 },
      (_, index) =>
        `{"id":"0-${index}","name":"Project ${String(index).padStart(3, "0")}","shortName":"P${index}"}`
    ).join(",")
    transport.enqueue(userJSON)
    transport.enqueue(`[${fullPage}]`)
    transport.enqueue(
      `[{"id":"0-100","name":"Project 100","shortName":"P100"}]`
    )

    const connection = await verify(transport, "https://youtrack.example.com")
    expect(connection.projects).toHaveLength(101)

    expect(transport.urls.slice(1)).toEqual([
      "https://youtrack.example.com/api/admin/projects?fields=id,name,shortName&$top=100&$skip=0",
      "https://youtrack.example.com/api/admin/projects?fields=id,name,shortName&$top=100&$skip=100",
    ])
  })

  test("a rejected token is an actionable error", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(`{"error":"Unauthorized"}`, 401)

    expect(
      await failureOf(
        verify(transport, "https://youtrack.example.com", "perm:expired")
      )
    ).toEqual({ kind: "tokenRejected" })
  })

  test("a project fetch failure fails the whole connect", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(userJSON)
    transport.enqueue(`{"error":"boom"}`, 500)

    expect(
      await failureOf(verify(transport, "https://youtrack.example.com"))
    ).toEqual({ kind: "unexpectedResponse", statusCode: 500 })
  })

  test.each(["", "   ", "not a url", "ftp://youtrack.example.com", "https://"])(
    "a malformed instance URL fails before any request (%j)",
    (entered) => {
      expect(
        failureOfSync(() => new YouTrackCredentials(entered, "perm:t"))
      ).toEqual({ kind: "invalidInstanceURL", entered })
    }
  )

  test.each([
    "http://youtrack.example.com",
    "http://10.0.0.5/yt",
    "http://LOCALHOST.example.com",
  ])(
    "a cleartext http URL beyond loopback is rejected before the token leaves the app (%s)",
    (entered) => {
      expect(
        failureOfSync(() => new YouTrackCredentials(entered, "perm:t"))
      ).toEqual({ kind: "insecureInstanceURL", entered })
    }
  )

  test("cleartext http to loopback is allowed — it never leaves the machine", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(userJSON)
    transport.enqueue(projectsJSON)

    await verify(transport, "http://localhost:8080")

    expect(transport.urls[0]).toBe(
      "http://localhost:8080/api/users/me?fields=login,fullName"
    )
  })

  test("a URL that answers with something other than YouTrack JSON is called out", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue("<!DOCTYPE html><html>intranet portal</html>")

    expect(await failureOf(verify(transport, "intranet.example.com"))).toEqual({
      kind: "notAYouTrackInstance",
      url: "https://intranet.example.com",
    })
  })

  test("a network failure propagates instead of being swallowed", async () => {
    const transport = new FakeHTTPTransport()
    const offline = new TypeError("fetch failed")
    transport.enqueueError(offline)

    await expect(verify(transport, "youtrack.example.com")).rejects.toBe(
      offline
    )
  })

  test("connection errors speak to the designer", () => {
    expect(
      new YouTrackError({ kind: "invalidInstanceURL", entered: "nope" }).message
    ).toBe(
      "“nope” is not a valid instance URL. Expected something like https://youtrack.example.com."
    )
    expect(
      new YouTrackError({
        kind: "insecureInstanceURL",
        entered: "http://yt.example.com",
      }).message
    ).toBe(
      "“http://yt.example.com” is not secure: the permanent token would travel unencrypted. Use https://."
    )
    expect(new YouTrackError({ kind: "tokenRejected" }).message).toBe(
      "YouTrack rejected the token. Check that the permanent token was pasted completely and is still valid."
    )
    expect(
      new YouTrackError({
        kind: "notAYouTrackInstance",
        url: "https://x.example",
      }).message
    ).toBe(
      "https://x.example did not answer like a YouTrack instance. Check the instance URL."
    )
    expect(
      new YouTrackError({ kind: "unexpectedResponse", statusCode: 502 }).message
    ).toBe(
      "YouTrack answered with HTTP 502. Check the instance URL, or try again later."
    )
  })

  // Not in the Swift suite: what Swift's URLComponents does with the rest of
  // a pasted URL, pinned so the port keeps it.
  test.each([
    ["https://youtrack.example.com", "https://youtrack.example.com"],
    ["https://youtrack.example.com///", "https://youtrack.example.com"],
    [
      "https://yt.example.com:8443/yt/?tab=1#top",
      "https://yt.example.com:8443/yt",
    ],
    ["  yt.example.com/youtrack  ", "https://yt.example.com/youtrack"],
    ["http://127.0.0.1:8080/", "http://127.0.0.1:8080"],
  ])("the instance URL %j is cleaned up to %j", (entered, cleaned) => {
    expect(new YouTrackCredentials(entered, "perm:t").instanceURL).toBe(cleaned)
  })

  test.each(["HTTPS://youtrack.example.com", "Http://localhost"])(
    "a scheme in capitals is refused, as URLComponents does (%s)",
    (entered) => {
      expect(
        failureOfSync(() => new YouTrackCredentials(entered, "perm:t"))
      ).toEqual({ kind: "invalidInstanceURL", entered })
    }
  )

  test("IPv6 loopback over http is refused: Swift compared the bracketed host", () => {
    expect(
      failureOfSync(
        () => new YouTrackCredentials("http://[::1]:8080", "perm:t")
      )
    ).toEqual({ kind: "insecureInstanceURL", entered: "http://[::1]:8080" })
  })

  test("a user without a full name is shown by login", async () => {
    const transport = new FakeHTTPTransport()
    transport.enqueue(`{"login":"vera","fullName":null}`)
    transport.enqueue("[]")

    const connection = await verify(transport, "https://youtrack.example.com")

    expect(connection.user).toEqual({ login: "vera", fullName: "vera" })
  })
})
