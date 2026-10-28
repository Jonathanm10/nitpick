// The home page's API end to end, in process: upload, the host check,
// Start and Resume review, a device switch and End review, as
// Sources/Nitpick/AppModel.swift sequences them. Not a port: the Swift shell
// had no tests of its own (its PRD kept it thin), and these pin what the
// issue's acceptance criteria name. The Device Host and YouTrack are fakes.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import {
  addFinding,
  decodeStoredSession,
  encodeStoredSession,
  newFinding,
  newReviewSession,
  type Build,
} from "@nitpick/core"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { FakeHTTPTransport } from "../../core/test/FakeHTTPTransport.ts"
import { projectsJSON, userJSON } from "../../core/test/fixtures.ts"
import type {
  ProjectsResponse,
  ReadyHost,
  ReviewStateResponse,
  StartReviewResponse,
} from "../src/api.ts"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import { claimIdleAfter, DeviceClaims } from "../src/device/deviceClaims.ts"
import { RuntimeUnavailable } from "../src/device/simctl.ts"
import {
  simulatorInfoPlist,
  temporaryDirectory,
  writeAppBundle,
} from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"
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
const brokenPhone: SimulatorDevice = {
  udid: "BBBB-2222",
  name: "Broken iPhone",
  osName: "iOS 26.4",
  isBooted: false,
  isRuntimeAvailable: false,
}

const schemaJSON = `[{"field":{"name":"Priority"},"bundle":{"values":[{"name":"Critical"},{"name":"Normal"}]}}]`

function harness(
  options: {
    readonly devices?: SimulatorDevice[]
    readonly maxBootedDevices?: number
    readonly now?: () => number
  } = {}
) {
  const runner = new FakeSubprocessRunner()
  const deviceHost = new FakeDeviceHost(
    options.devices ?? [iPad, iPhone, brokenPhone]
  )
  const deviceClaims = new DeviceClaims({
    limit: options.maxBootedDevices,
    shutDown: deviceHost.shutDown,
    now: options.now,
  })
  const transport = new FakeHTTPTransport()
  const { app, directory } = signedInApp({
    data: temporaryDirectory(),
    deviceHost,
    runner,
    transport,
    deviceClaims,
  })
  return {
    app,
    runner,
    deviceHost,
    deviceClaims,
    transport,
    reviewerDirectory: directory,
  }
}

type Harness = ReturnType<typeof harness>

/** Stubs tar so the upload extracts to a Build named `appName`. */
function enqueueExtraction(
  { runner }: Harness,
  appName = "ReviewMe.app",
  plist = simulatorInfoPlist()
) {
  runner.enqueue({
    exitCode: 0,
    effect: (command) => {
      writeAppBundle(command.arguments[4], appName, plist)
    },
  })
}

function upload({ app }: Harness, name = "ReviewMe.zip") {
  return app.request(`/api/build?name=${encodeURIComponent(name)}`, {
    method: "POST",
    body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
  })
}

function startReview(
  { app }: Harness,
  body: unknown = { deviceUDID: iPhone.udid, projectID: "0-12" }
) {
  return app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function enqueueProjectsAndSchema({ transport }: Harness) {
  transport.enqueue(userJSON)
  transport.enqueue(projectsJSON)
  transport.enqueue(schemaJSON)
}

async function review({ app }: Harness) {
  const response = await app.request("/api/review")
  return (await response.json()) as ReviewStateResponse
}

async function recentDeviceUDIDs({ app }: Harness) {
  const host = (await (await app.request("/api/host")).json()) as ReadyHost
  return host.recentDeviceUDIDs
}

function storedSession({ reviewerDirectory }: Harness) {
  const path = join(reviewerDirectory, "open-session", "session.json")
  return existsSync(path)
    ? decodeStoredSession(readFileSync(path, "utf8"))
    : undefined
}

function buildDirectories({ reviewerDirectory }: Harness) {
  return readdirSync(join(reviewerDirectory, "builds"))
}

const reviewMe = {
  name: "ReviewMe",
  identity: {
    bundleID: "ch.liip.reviewme",
    version: "2.1.0",
    buildNumber: "421",
  },
}

describe("Build upload", () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  test("a zipped Build is ingested and shown by name and identity", async () => {
    enqueueExtraction(h)

    const response = await upload(h)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ build: reviewMe })
    expect(await review(h)).toEqual({
      build: reviewMe,
      filing: { status: "idle" },
    })
    // The zip is gone once extracted; its Build stays for the launch.
    expect(readdirSync(join(h.reviewerDirectory, "uploads"))).toEqual([])
    expect(buildDirectories(h)).toHaveLength(1)
  })

  test("a file that isn't a zip is refused before anything runs", async () => {
    const response = await upload(h, "ReviewMe.app")

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error:
        "“ReviewMe.app” is not a Build. Drop or choose a zip containing a simulator .app.",
    })
    expect(h.runner.executedCommands).toEqual([])
  })

  test("a bad upload changes nothing: the Build, the session and the files stay", async () => {
    enqueueExtraction(h)
    await upload(h)
    enqueueProjectsAndSchema(h)
    await startReview(h)
    const before = storedSession(h)
    h.runner.enqueue({ exitCode: 0 }) // a zip with no .app inside

    const response = await upload(h, "Empty.zip")

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "“Empty.zip” contains no .app bundle.",
    })
    expect((await review(h)).build).toEqual(reviewMe)
    expect(storedSession(h)).toEqual(before)
    expect(buildDirectories(h)).toHaveLength(1)
  })

  test("a good upload ends the open session and drops the old Build's files", async () => {
    enqueueExtraction(h)
    await upload(h)
    enqueueProjectsAndSchema(h)
    await startReview(h)
    const [oldBuild] = buildDirectories(h)
    enqueueExtraction(
      h,
      "NextUp.app",
      simulatorInfoPlist({ buildNumber: "422" })
    )

    const response = await upload(h, "NextUp.zip")

    expect(response.status).toBe(200)
    expect(await review(h)).toEqual({
      build: {
        name: "NextUp",
        identity: { ...reviewMe.identity, buildNumber: "422" },
      },
      filing: { status: "idle" },
    })
    expect(storedSession(h)).toBeUndefined()
    expect(buildDirectories(h)).not.toContain(oldBuild)
    expect(buildDirectories(h)).toHaveLength(1)
  })

  test("work that starts while an upload runs is refused with the busy message", async () => {
    let finishExtraction = () => {}
    const extracting = new Promise<void>((resolve) => {
      finishExtraction = resolve
    })
    h.runner.enqueue({
      exitCode: 0,
      effect: async (command) => {
        await extracting
        writeAppBundle(
          command.arguments[4],
          "ReviewMe.app",
          simulatorInfoPlist()
        )
      },
    })
    const first = upload(h)
    await vi.waitFor(() => expect(h.runner.executedCommands).toHaveLength(1))

    const second = await upload(h, "Other.zip")
    const start = await startReview(h)
    finishExtraction()

    const busy = {
      error:
        "Nitpick was busy, so that didn’t run. Try again when the current step finishes.",
    }
    expect(second.status).toBe(409)
    expect(await second.json()).toEqual(busy)
    expect(start.status).toBe(409)
    expect(await start.json()).toEqual(busy)
    expect((await first).status).toBe(200)
    expect(h.runner.executedCommands).toHaveLength(1)
  })
})

describe("Start review", () => {
  let h: Harness

  beforeEach(async () => {
    h = harness()
    enqueueExtraction(h)
    await upload(h)
  })

  test("re-checks the host, launches, records the device, reads the schema and saves the session", async () => {
    enqueueProjectsAndSchema(h)

    const response = await startReview(h)

    expect(response.status).toBe(200)
    const body = (await response.json()) as StartReviewResponse
    if (body.status !== "started") throw new Error("expected a started review")
    expect(body).toMatchObject({
      status: "started",
      session: {
        project: { id: "0-12", shortName: "RM", name: "Review Me" },
        tray: [],
      },
      device: iPhone,
      schema: { priorities: [{ name: "Critical" }, { name: "Normal" }] },
      host: { status: "ready", recentDeviceUDIDs: [iPhone.udid] },
    })
    expect(h.deviceHost.launches.map((launch) => launch.device)).toEqual([
      iPhone,
    ])
    expect(h.deviceHost.launches[0].build.identity).toEqual(reviewMe.identity)
    const saved = storedSession(h)
    expect(saved?.project.id).toBe("0-12")
    expect(saved?.startedAt).toBe(body.session.startedAt)
    expect(h.transport.urls.map((url) => new URL(url).pathname)).toEqual([
      "/api/users/me",
      "/api/admin/projects",
      "/api/admin/projects/0-12/customFields",
    ])
  })

  test("a host that isn't ready says why, and nothing launches or saves", async () => {
    h.deviceHost.health = {
      status: "notReady",
      problem: { kind: "xcodeSetupIncomplete" },
    }

    const response = await startReview(h)

    expect(await response.json()).toEqual({
      status: "notReady",
      reason:
        "Xcode is installed on the Device Host, but its simulator tools aren't working yet.",
    })
    expect(h.deviceHost.launches).toEqual([])
    expect(storedSession(h)).toBeUndefined()
  })

  test("a reload finds the open session; the device run is the page's, so it shows paused", async () => {
    enqueueProjectsAndSchema(h)
    await startReview(h)

    expect(await review(h)).toMatchObject({
      build: reviewMe,
      session: { project: { shortName: "RM" }, tray: [] },
    })
  })

  test("Resume review relaunches under the pinned project, whatever the picker sends", async () => {
    enqueueProjectsAndSchema(h)
    await startReview(h)
    const opened = storedSession(h)
    h.transport.enqueue(schemaJSON)

    const response = await startReview(h, {
      deviceUDID: iPad.udid,
      projectID: "0-3",
    })

    expect(await response.json()).toMatchObject({
      status: "started",
      session: { project: { id: "0-12" } },
      device: iPad,
      host: { recentDeviceUDIDs: [iPad.udid, iPhone.udid] },
    })
    expect(storedSession(h)).toEqual(opened)
    expect(h.deviceHost.launches).toHaveLength(2)
  })

  test("a runtime-missing device is refused with the host's story", async () => {
    h.deviceHost.launchBuild = async (_build, device) => {
      throw new RuntimeUnavailable(device)
    }
    enqueueProjectsAndSchema(h)

    const response = await startReview(h, {
      deviceUDID: brokenPhone.udid,
      projectID: "0-12",
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error:
        "Broken iPhone can't be booted: its iOS 26.4 simulator runtime isn't installed on the Device Host. Ask whoever runs the Device Host to install it.",
    })
    expect(storedSession(h)).toBeUndefined()
  })

  test("a failed launch records no Recent device and saves no session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    h.deviceHost.launchFailure = new Error("Failed to install")
    h.transport.enqueue(userJSON)
    h.transport.enqueue(projectsJSON)

    const response = await startReview(h)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: "Failed to install" })
    expect(storedSession(h)).toBeUndefined()
    expect(await recentDeviceUDIDs(h)).toEqual([])
  })

  test("a project the server's account can't see is refused before any launch", async () => {
    h.transport.enqueue(userJSON)
    h.transport.enqueue(projectsJSON)

    const response = await startReview(h, {
      deviceUDID: iPhone.udid,
      projectID: "0-404",
    })

    expect(response.status).toBe(409)
    expect(h.deviceHost.launches).toEqual([])
  })

  test("a malformed request is refused", async () => {
    const response = await startReview(h, { deviceUDID: 42 })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "The request is malformed.",
    })
  })
})

describe("The host's cap on booted devices", () => {
  const noor = { login: "noor", fullName: "Noor Haddad" }
  const bootedIPad = { ...iPad, isBooted: true }

  async function cappedHarness(now?: () => number) {
    const h = harness({
      devices: [bootedIPad, iPhone, brokenPhone],
      maxBootedDevices: 1,
      now,
    })
    enqueueExtraction(h)
    await upload(h)
    return h
  }

  test("a start that needs room shuts down a booted device nobody reviews on, then launches", async () => {
    const h = await cappedHarness()
    enqueueProjectsAndSchema(h)

    const response = await startReview(h)

    expect(response.status).toBe(200)
    expect(h.deviceHost.shutdowns).toEqual([iPad.udid])
    expect(h.deviceHost.launches.map((launch) => launch.device)).toEqual([
      iPhone,
    ])
  })

  test("with the host full, Start review names who reviews there, and nothing shuts down, launches or saves", async () => {
    const h = await cappedHarness()
    await h.deviceClaims.claim(noor, bootedIPad, [bootedIPad])
    enqueueProjectsAndSchema(h)

    const response = await startReview(h)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error:
        "The Device Host is full: Noor Haddad is using its only device. Try again once a review there ends.",
    })
    expect(h.deviceHost.shutdowns).toEqual([])
    expect(h.deviceHost.launches).toEqual([])
    expect(storedSession(h)).toBeUndefined()
  })

  test("the Reviewer's requests keep their device theirs past the idle time", async () => {
    let now = 0
    const h = await cappedHarness(() => now)
    enqueueProjectsAndSchema(h)
    await startReview(h)
    const booted = [iPad, { ...iPhone, isBooted: true }]

    now += claimIdleAfter - 1
    await review(h)
    now += claimIdleAfter - 1

    await expect(h.deviceClaims.claim(noor, iPad, booted)).rejects.toThrow(
      "Vera Baumann is using its only device"
    )
  })

  test("a launch that fails gives the device up at once", async () => {
    const h = await cappedHarness()
    h.deviceHost.launchFailure = new Error("Failed to install")
    enqueueProjectsAndSchema(h)

    expect((await startReview(h)).status).toBe(500)

    await h.deviceClaims.claim(noor, iPad, [iPad, iPhone])
  })

  test.each([
    [
      "End review",
      (h: Harness) => h.app.request("/api/session", { method: "DELETE" }),
    ],
    [
      "A new Build",
      (h: Harness) => {
        enqueueExtraction(h)
        return upload(h)
      },
    ],
  ])("%s gives the device up to the next Reviewer", async (_, endSession) => {
    const h = await cappedHarness()
    enqueueProjectsAndSchema(h)
    await startReview(h)
    const bootedIPhone = { ...iPhone, isBooted: true }
    await expect(
      h.deviceClaims.claim(noor, iPad, [iPad, bootedIPhone])
    ).rejects.toThrow("Vera Baumann is using its only device")

    expect((await endSession(h)).ok).toBe(true)

    await h.deviceClaims.claim(noor, iPad, [iPad, bootedIPhone])
    expect(h.deviceHost.shutdowns).toEqual([iPad.udid, iPhone.udid])
  })
})

describe("In the session", () => {
  let h: Harness

  beforeEach(async () => {
    h = harness()
    enqueueExtraction(h)
    await upload(h)
    enqueueProjectsAndSchema(h)
    await startReview(h)
  })

  function switchTo(deviceUDID: string) {
    return h.app.request("/api/session/device", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceUDID }),
    })
  }

  test("switching device relaunches the Build there and records it in Recent", async () => {
    const response = await switchTo(iPad.udid)

    expect(await response.json()).toEqual({
      device: iPad,
      recentDeviceUDIDs: [iPad.udid, iPhone.udid],
    })
    expect(h.deviceHost.launches.map((launch) => launch.device)).toEqual([
      iPhone,
      iPad,
    ])
  })

  test("a device another Reviewer is reviewing on is refused, and nothing relaunches", async () => {
    const noor = { login: "noor", fullName: "Noor Haddad" }
    await h.deviceClaims.claim(noor, iPad, [iPad])

    const response = await switchTo(iPad.udid)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Noor Haddad is reviewing on iPad (A16). Pick another device.",
    })
    expect(h.deviceHost.launches.map((launch) => launch.device)).toEqual([
      iPhone,
    ])
  })

  test("a failed switch leaves Recent and the session as they were", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const opened = storedSession(h)
    h.deviceHost.launchFailure = new Error("Unable to boot")

    const response = await switchTo(iPad.udid)

    expect(response.status).toBe(500)
    expect(storedSession(h)).toEqual(opened)
    expect(await recentDeviceUDIDs(h)).toEqual([iPhone.udid])
  })

  test("End review drops the session and keeps the Build loaded", async () => {
    const response = await h.app.request("/api/session", { method: "DELETE" })

    expect(response.status).toBe(204)
    expect(storedSession(h)).toBeUndefined()
    expect(await review(h)).toEqual({
      build: reviewMe,
      filing: { status: "idle" },
    })
  })
})

describe("A session left open", () => {
  test("is found after a server restart, with its Findings counted", async () => {
    const h = harness()
    const build: Build = {
      identity: reviewMe.identity,
      appBundleURL: "file:///data/builds/b1/ReviewMe.app/",
    }
    let session = newReviewSession({
      build,
      project: { id: "0-12", shortName: "RM", name: "Review Me" },
    })
    for (const summary of ["Header clips", ""]) {
      session = addFinding(
        session,
        newFinding({
          summary,
          description: "",
          deviceContext: {
            deviceModel: "iPhone 17 Pro",
            osName: "iOS 26.4",
            accessibilitySettings: [],
          },
        })
      ).session
    }
    mkdirSync(join(h.reviewerDirectory, "open-session"), { recursive: true })
    writeFileSync(
      join(h.reviewerDirectory, "open-session", "session.json"),
      encodeStoredSession(session)
    )

    expect(await review(h)).toEqual({
      build: reviewMe,
      session: {
        project: session.project,
        startedAt: session.startedAt,
        tray: session.tray,
      },
      filing: { status: "idle" },
    })
  })
})

describe("Host and projects", () => {
  test("the host check lists the devices with the Reviewer's Recent devices", async () => {
    const h = harness()

    const body = await (await h.app.request("/api/host")).json()

    expect(body).toEqual({
      status: "ready",
      devices: [iPad, iPhone, brokenPhone],
      recentDeviceUDIDs: [],
    })
  })

  test("a host that isn't ready answers with its reason only", async () => {
    const h = harness()
    h.deviceHost.health = {
      status: "notReady",
      problem: {
        kind: "commandLineToolsOnly",
        developerDirectory: "/Library/Developer/CommandLineTools",
      },
    }

    const body = await (await h.app.request("/api/host")).json()

    expect(body).toEqual({
      status: "notReady",
      reason:
        "The Device Host has only the Command Line Tools selected, and the iOS simulator ships with full Xcode.",
    })
  })

  test("projects come from the signed-in Reviewer's YouTrack account, sorted by name", async () => {
    const h = harness()
    h.transport.enqueue(userJSON)
    h.transport.enqueue(projectsJSON)

    const response = await h.app.request("/api/projects")
    const { projects } = (await response.json()) as ProjectsResponse

    expect(projects.map((project) => project.shortName)).toEqual(["ATL", "RM"])
  })

  test("a YouTrack failure keeps today's message", async () => {
    const h = harness()
    h.transport.enqueue("{}", 503)

    const response = await h.app.request("/api/projects")

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error:
        "YouTrack answered with HTTP 503. Check the instance URL, or try again later.",
    })
  })
})
