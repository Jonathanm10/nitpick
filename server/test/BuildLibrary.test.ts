// The Build Library end to end, in process (ADR-0016): two Reviewers on one
// server, where an upload lands for everyone and a pick starts a review on a
// Build someone else uploaded. The Device Host and YouTrack are fakes; all
// users and Builds are fictional.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { decodeStoredSession, newUUID } from "@nitpick/core"
import { describe, expect, test, vi } from "vitest"
import type {
  BuildResponse,
  LibraryResponse,
  ReviewStateResponse,
} from "../src/api.ts"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import {
  simulatorInfoPlist,
  temporaryDirectory,
  writeAppBundle,
} from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"
import { FakeYouTrack } from "./FakeYouTrack.ts"
import { signedInApp } from "./SignedIn.ts"

const iPhone: SimulatorDevice = {
  udid: "AAAA-1111",
  name: "iPhone 17 Pro",
  osName: "iOS 26.4",
  isBooted: false,
  isRuntimeAvailable: true,
}
const iPad: SimulatorDevice = {
  udid: "DDDD-4444",
  name: "iPad (A16)",
  osName: "iOS 26.5",
  isBooted: false,
  isRuntimeAvailable: true,
}

const reviewMe = {
  name: "ReviewMe",
  identity: {
    bundleID: "ch.liip.reviewme",
    version: "2.1.0",
    buildNumber: "421",
  },
  platform: "ios",
}
const nextUp = {
  name: "NextUp",
  identity: { ...reviewMe.identity, buildNumber: "422" },
  platform: "ios",
}

/**
 * The server over `data`, a restart's too, with Vera signed in and Noor
 * beside her. Each upload is stamped a minute after the last.
 */
function server(
  data = temporaryDirectory(),
  clock = { now: Date.UTC(2026, 10, 23, 9) }
) {
  const fake = new FakeYouTrack()
  const runner = new FakeSubprocessRunner()
  const deviceHost = new FakeDeviceHost([iPhone, iPad])
  const signedIn = signedInApp({
    data,
    deviceHost,
    runner,
    transport: fake.transport,
    instanceURL: fake.instanceURL,
    user: fake.users["perm:vera"],
    libraryNow: () => new Date((clock.now += 60_000)),
  })
  return {
    data,
    clock,
    runner,
    deviceHost,
    vera: signedIn.app,
    noor: signedIn.signedInAs(fake.users["perm:noor"]!),
    libraryDirectory: join(data, "library"),
  }
}

type Server = ReturnType<typeof server>
type Browser = Server["vera"]

/** Uploads `<app>.zip`, whose extraction writes the .app with `plist`. */
function upload(
  h: Server,
  as: Browser,
  app = "ReviewMe",
  plist = simulatorInfoPlist()
) {
  h.runner.enqueue({
    exitCode: 0,
    effect: (command) => {
      writeAppBundle(command.arguments[4], `${app}.app`, plist)
    },
  })
  return as.request(`/api/build?name=${app}.zip`, {
    method: "POST",
    body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  })
}

/** The uploaded Build's Library id. */
async function uploaded(
  h: Server,
  as: Browser,
  app?: string,
  plist?: ReturnType<typeof simulatorInfoPlist>
): Promise<string> {
  const response = await upload(h, as, app, plist)
  expect(response.status).toBe(200)
  return ((await response.json()) as BuildResponse).build.id!
}

async function library(as: Browser) {
  const response = await as.request("/api/library")
  return ((await response.json()) as LibraryResponse).builds
}

function pick(as: Browser, id: unknown) {
  return as.request("/api/build", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })
}

function start(as: Browser, device: SimulatorDevice) {
  return as.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceUDID: device.udid, projectID: "0-12" }),
  })
}

async function review(as: Browser) {
  const response = await as.request("/api/review")
  return (await response.json()) as ReviewStateResponse
}

function storedSession({ data }: Server, login: string) {
  const path = join(data, "reviewers", login, "open-session", "session.json")
  return existsSync(path)
    ? decodeStoredSession(readFileSync(path, "utf8"))
    : undefined
}

function launchedFrom(h: Server) {
  return h.deviceHost.launches.map(({ build }) =>
    fileURLToPath(build.appBundleURL)
  )
}

describe("The Build Library", () => {
  test("an upload lands in every Reviewer's Library, newest first, with who uploaded it and when", async () => {
    const h = server()
    const first = await uploaded(h, h.vera)
    const second = await uploaded(
      h,
      h.noor,
      "NextUp",
      simulatorInfoPlist({ buildNumber: "422" })
    )

    const listed = [
      {
        ...nextUp,
        id: second,
        uploadedBy: { login: "noor", name: "Noor Haddad" },
        uploadedAt: "2026-11-23T09:02:00.000Z",
      },
      {
        ...reviewMe,
        id: first,
        uploadedBy: { login: "vera", name: "Vera Baumann" },
        uploadedAt: "2026-11-23T09:01:00.000Z",
      },
    ]
    expect(await library(h.vera)).toEqual(listed)
    expect(await library(h.noor)).toEqual(listed)
    // Each upload is its uploader's Build, and nobody else's.
    expect((await review(h.vera)).build).toEqual({ ...reviewMe, id: first })
    expect((await review(h.noor)).build).toEqual({ ...nextUp, id: second })
    const body = await (await h.vera.request("/api/library")).text()
    expect(body).not.toContain(h.data)
  })

  test("a Reviewer picks a Build another uploaded, and starts a review on it", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)
    const [listed] = await library(h.noor)

    const picked = await pick(h.noor, listed!.id)
    const started = await start(h.noor, iPad)

    expect(picked.status).toBe(200)
    expect(await picked.json()).toEqual({ build: { ...reviewMe, id } })
    expect(started.status).toBe(200)
    const appPath = join(h.libraryDirectory, id, "build", "ReviewMe.app")
    expect(launchedFrom(h)).toEqual([`${appPath}/`])
    expect(fileURLToPath(storedSession(h, "noor")!.build.appBundleURL)).toBe(
      `${appPath}/`
    )
    expect(storedSession(h, "vera")).toBeUndefined()
  })

  test("picking another Build ends the open review, as an upload does; picking the one under review changes nothing", async () => {
    const h = server()
    const first = await uploaded(h, h.vera)
    const second = await uploaded(
      h,
      h.vera,
      "NextUp",
      simulatorInfoPlist({ buildNumber: "422" })
    )
    expect((await start(h.vera, iPhone)).status).toBe(200)
    const opened = storedSession(h, "vera")

    const same = await pick(h.vera, second)
    const kept = storedSession(h, "vera")
    const other = await pick(h.vera, first)

    expect(same.status).toBe(200)
    expect(kept).toEqual(opened)
    expect(other.status).toBe(200)
    expect(storedSession(h, "vera")).toBeUndefined()
    expect(await review(h.vera)).toEqual({
      build: { ...reviewMe, id: first },
      filing: { status: "idle" },
    })
    // The device went with the review: Noor can review on it now.
    expect((await pick(h.noor, first)).status).toBe(200)
    expect((await start(h.noor, iPhone)).status).toBe(200)
  })

  test("a pick of a Build that isn't in the Library is a 404, and a malformed one a 400", async () => {
    const h = server()

    const gone = await pick(h.vera, newUUID())
    const malformed = await pick(h.vera, 42)

    expect(gone.status).toBe(404)
    expect(await gone.json()).toEqual({
      error: "That Build is no longer in the Build Library.",
    })
    expect(malformed.status).toBe(400)
  })
})

describe("Across a restart", () => {
  test("the Library stays; a Reviewer's pick, held in memory, doesn't", async () => {
    const before = server()
    const id = await uploaded(before, before.vera)
    const listed = await library(before.vera)

    const after = server(before.data, before.clock)

    expect(await library(after.noor)).toEqual(listed)
    expect(await review(after.vera)).toEqual({ filing: { status: "idle" } })
    expect((await pick(after.vera, id)).status).toBe(200)
    expect((await start(after.vera, iPhone)).status).toBe(200)
    expect(launchedFrom(after)).toEqual([
      `${join(after.libraryDirectory, id, "build", "ReviewMe.app")}/`,
    ])
  })

  test("an upload the restart cut short is swept, and the finished ones stay", async () => {
    const before = server()
    const id = await uploaded(before, before.vera)
    before.runner.enqueue({
      exitCode: 0,
      effect: async (command) => {
        writeAppBundle(command.arguments[4], "Half.app", simulatorInfoPlist())
        await new Promise(() => {})
      },
    })
    void before.noor.request("/api/build?name=Half.zip", {
      method: "POST",
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    await vi.waitFor(() =>
      expect(readdirSync(before.libraryDirectory)).toHaveLength(2)
    )

    const after = server(before.data, before.clock)

    expect((await library(after.vera)).map((build) => build.id)).toEqual([id])
    expect(readdirSync(after.libraryDirectory)).toEqual([id])
  })
})
