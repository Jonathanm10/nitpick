// A release puts its Build into the Build Library with the upload token
// (ADR-0017), and no sign-in. The Device Host is a fake; all users, tokens
// and Builds are fictional.
import { describe, expect, test } from "vitest"
import type {
  BuildResponse,
  LibraryResponse,
  ReviewStateResponse,
} from "../src/api.ts"
import {
  simulatorInfoPlist,
  temporaryDirectory,
  writeAppBundle,
} from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"
import { signedInApp } from "./SignedIn.ts"

const uploadToken = "fictional-upload-token-0123456789abcdef"
const withToken = { Authorization: `Bearer ${uploadToken}` }

const reviewMe = {
  name: "ReviewMe",
  identity: {
    bundleID: "ch.liip.reviewme",
    version: "2.1.0",
    buildNumber: "421",
  },
  platform: "ios",
}

/** A server with Vera signed in, which takes `token` from a release. */
function server(token: string | undefined) {
  const runner = new FakeSubprocessRunner()
  let now = Date.UTC(2026, 10, 24, 9)
  const signedIn = signedInApp({
    data: temporaryDirectory(),
    deviceHost: new FakeDeviceHost([]),
    runner,
    uploadToken: token,
    libraryNow: () => new Date((now += 60_000)),
  })
  return { ...signedIn, runner }
}

type Server = ReturnType<typeof server>
type Client = {
  request(path: string, init?: RequestInit): Response | Promise<Response>
}

/** The next zip's extraction writes `app`.app, or nothing for null. */
function extracting(h: Server, app: string | null = "ReviewMe") {
  h.runner.enqueue({
    exitCode: 0,
    effect: (command) => {
      if (app !== null) {
        writeAppBundle(command.arguments[4], `${app}.app`, simulatorInfoPlist())
      }
    },
  })
}

/** A release's upload, as fastlane sends it: no cookie unless `via` has one. */
function release(
  h: Server,
  headers: Record<string, string>,
  {
    name = "ReviewMe.zip",
    via = h.server,
  }: { name?: string; via?: Client } = {}
) {
  return via.request(`/api/library?name=${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...headers },
    body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  })
}

async function library(h: Server) {
  const response = await h.app.request("/api/library")
  return ((await response.json()) as LibraryResponse).builds
}

describe("A release's upload", () => {
  test("with the token, the Build lands in the Library for every Reviewer, uploaded by the releaser and picked by nobody", async () => {
    const h = server(uploadToken)
    extracting(h)

    const response = await release(h, {
      ...withToken,
      "X-Nitpick-Uploader": "  Lea Keller  ",
    })

    expect(response.status).toBe(201)
    expect(response.headers.get("set-cookie")).toBeNull()
    const { build } = (await response.json()) as BuildResponse
    expect(build).toEqual({ ...reviewMe, id: expect.any(String) })
    expect(await library(h)).toEqual([
      {
        ...build,
        uploadedBy: { login: "", name: "Lea Keller" },
        uploadedAt: "2026-11-24T09:01:00.000Z",
        inUse: false,
      },
    ])
    const review = await h.app.request("/api/review")
    expect(((await review.json()) as ReviewStateResponse).build).toBeUndefined()
  })

  test("the releaser's name is read as UTF-8, cut at 100 characters, and Release without one", async () => {
    const h = server(uploadToken)
    // UTF-8 bytes reach the server one per character. A Latin-1 sender's
    // "Zo\u00eb" isn't UTF-8, and is kept as it came.
    const utf8OnTheWire = Buffer.from("Zoë Müller", "utf8").toString("latin1")
    const names = [utf8OnTheWire, "Zo\u00eb", "x".repeat(150), undefined]

    for (const name of names) {
      extracting(h)
      const response = await release(h, {
        ...withToken,
        ...(name !== undefined && { "X-Nitpick-Uploader": name }),
      })
      expect(response.status).toBe(201)
    }

    expect((await library(h)).map((build) => build.uploadedBy.name)).toEqual([
      "Release",
      "x".repeat(100),
      "Zoë",
      "Zoë Müller",
    ])
  })

  test("without the right token it is 401, a Reviewer's sign-in included, and the Library stays as it was", async () => {
    const h = server(uploadToken)

    const refused = [
      await release(h, {}),
      await release(h, { Authorization: `Bearer ${uploadToken}x` }),
      await release(h, { Authorization: `Bearer ${uploadToken.slice(1)}` }),
      await release(h, { Authorization: `Basic ${uploadToken}` }),
      await release(h, { Authorization: uploadToken }),
      await release(h, {}, { name: `ReviewMe.zip&token=${uploadToken}` }),
      await release(h, {}, { via: h.app }),
    ]

    for (const response of refused) {
      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(await response.json()).toEqual({ error: expect.any(String) })
    }
    expect(h.runner.executedCommands).toEqual([])
    expect(await library(h)).toEqual([])
  })

  test("on a host with no upload token it is 404, naming NITPICK_UPLOAD_TOKEN", async () => {
    const h = server(undefined)

    const response = await release(h, withToken)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: expect.stringContaining("NITPICK_UPLOAD_TOKEN"),
    })
    expect(h.runner.executedCommands).toEqual([])
    expect(await library(h)).toEqual([])
  })

  test.each([
    ["a file that isn't a zip", "notes.txt", false],
    ["a zip without an .app", "ReviewMe.zip", true],
  ])(
    "%s is refused as a Reviewer's upload is, and the Library stays as it was",
    async (_, name, extracts) => {
      const h = server(uploadToken)

      if (extracts) extracting(h, null)
      const fromRelease = await release(h, withToken, { name })
      if (extracts) extracting(h, null)
      const fromReviewer = await h.app.request(`/api/build?name=${name}`, {
        method: "POST",
        body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      })

      expect(fromRelease.status).toBe(400)
      expect(fromRelease.status).toBe(fromReviewer.status)
      expect(await fromRelease.json()).toEqual(await fromReviewer.json())
      expect(await library(h)).toEqual([])
    }
  )
})
