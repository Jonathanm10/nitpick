// The Build Library end to end, in process (ADR-0016): two Reviewers on one
// server, where an upload lands for everyone, a pick starts a review on a
// Build someone else uploaded, and a Build in a review can't be deleted. The
// Device Host and YouTrack are fakes; all users and Builds are fictional.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  decodeStoredSession,
  encodeStoredSession,
  newReviewSession,
  newUUID,
} from "@nitpick/core"
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
  const sessionReads = {
    held: 0,
    /** Holds each read of the open sessions before it reads them. */
    before: undefined as Promise<void> | undefined,
    /** Holds it once it has read them, before the Library sees what it read. */
    after: undefined as Promise<void> | undefined,
  }
  const signedIn = signedInApp({
    data,
    deviceHost,
    runner,
    transport: fake.transport,
    instanceURL: fake.instanceURL,
    user: fake.users["perm:vera"],
    libraryNow: () => new Date((clock.now += 60_000)),
    openSessionBuilds: async (read) => {
      if (sessionReads.before !== undefined) {
        sessionReads.held++
        await sessionReads.before
      }
      const builds = await read()
      if (sessionReads.after !== undefined) {
        sessionReads.held++
        await sessionReads.after
      }
      return builds
    },
  })
  return {
    data,
    clock,
    runner,
    deviceHost,
    sessionReads,
    vera: signedIn.app,
    noor: signedIn.signedInAs(fake.users["perm:noor"]!),
    libraryDirectory: join(data, "library"),
    buildLibrary: signedIn.library,
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

/** Start review, from a page that shows the Build `buildID` names. */
function start(as: Browser, device: SimulatorDevice, buildID?: string) {
  return as.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceUDID: device.udid,
      projectID: "0-12",
      buildID,
    }),
  })
}

function end(as: Browser) {
  return as.request("/api/session", { method: "DELETE" })
}

function remove(as: Browser, id: string) {
  return as.request(`/api/library/${id}`, { method: "DELETE" })
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

/** An open session of `login`'s on disk, on the Build at `appBundleURL`. */
function writeOpenSession(
  { data }: Server,
  login: string,
  appBundleURL: string
) {
  const directory = join(data, "reviewers", login, "open-session")
  mkdirSync(directory, { recursive: true })
  const session = newReviewSession({
    build: { identity: reviewMe.identity, appBundleURL },
    project: { id: "0-12", shortName: "RM", name: "ReviewMe" },
  })
  writeFileSync(join(directory, "session.json"), encodeStoredSession(session))
}

function launchedFrom(h: Server) {
  return h.deviceHost.launches.map(({ build }) =>
    fileURLToPath(build.appBundleURL)
  )
}

/** A promise that settles once `open` is called. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

/** Holds each launch until `release`, as a slow boot would. */
function holdLaunches(h: Server) {
  const launch = h.deviceHost.launchBuild
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const held: string[] = []
  h.deviceHost.launchBuild = async (build, device) => {
    held.push(device.udid)
    await released
    return launch(build, device)
  }
  return { held, release }
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
        inUse: false,
      },
      {
        ...reviewMe,
        id: first,
        uploadedBy: { login: "vera", name: "Vera Baumann" },
        uploadedAt: "2026-11-23T09:01:00.000Z",
        inUse: false,
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
    const started = await start(h.noor, iPad, id)

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
    expect((await start(h.vera, iPhone, second)).status).toBe(200)
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
    expect((await start(h.noor, iPhone, first)).status).toBe(200)
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

  test("deleting is refused while a review is open on the Build, and done once it ends", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)
    await pick(h.noor, id)
    await start(h.noor, iPad, id)

    const refused = await remove(h.vera, id)
    const listedInUse = await library(h.vera)
    await end(h.noor)
    const listedAfter = await library(h.vera)
    const deleted = await remove(h.vera, id)
    const again = await remove(h.vera, id)

    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error:
        "This Build is in a review, so it can't be deleted. Try again once that review ends.",
    })
    expect(listedInUse.map((build) => build.inUse)).toEqual([true])
    expect(listedAfter.map((build) => build.inUse)).toEqual([false])
    expect(deleted.status).toBe(204)
    expect(again.status).toBe(404)
    expect(await library(h.noor)).toEqual([])
    expect(readdirSync(h.libraryDirectory)).toEqual([])
    // Both had it as their Build; now neither has one.
    expect(await review(h.vera)).toEqual({ filing: { status: "idle" } })
    expect(await review(h.noor)).toEqual({ filing: { status: "idle" } })
  })

  test("deleting a Build its Reviewer picked but hasn't started on leaves them with none, and Start review refused", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)

    const deleted = await remove(h.noor, id)
    const started = await start(h.vera, iPhone, id)

    expect(deleted.status).toBe(204)
    expect(started.status).toBe(409)
    expect(await started.json()).toEqual({
      error: "That Build was deleted from the Build Library. Pick another one.",
    })
    expect(h.deviceHost.launches).toEqual([])
    expect(storedSession(h, "vera")).toBeUndefined()
    expect(await review(h.vera)).toEqual({ filing: { status: "idle" } })
    expect(await (await start(h.vera, iPhone)).json()).toEqual({
      error: "Pick or upload a Build before starting a review.",
    })
  })

  test("deleting is refused while a review is open on the Build where the Library was before a move to another home", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)
    writeOpenSession(
      h,
      "noor",
      `file:///Users/previous/nitpick-data/library/${id}/build/ReviewMe.app/`
    )

    const refused = await remove(h.vera, id)

    expect(refused.status).toBe(409)
    expect((await library(h.vera)).map((build) => build.inUse)).toEqual([true])
  })

  test("a Build id that names no entry deletes nothing", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)

    const outside = await remove(h.vera, "..%2Freviewers%2Fvera")
    const unknown = await remove(h.vera, "not-a-build")

    expect([outside.status, unknown.status]).toEqual([404, 404])
    expect((await library(h.vera)).map((build) => build.id)).toEqual([id])
  })
})

describe("Start review", () => {
  test("from a page that shows another Build than the Reviewer's is refused before any device is theirs, and a start answers with its Build", async () => {
    const h = server()
    const shown = await uploaded(h, h.vera)
    // Another tab of Vera's uploads the next Build, which is hers now.
    const theirs = await uploaded(
      h,
      h.vera,
      "NextUp",
      simulatorInfoPlist({ buildNumber: "422" })
    )

    const stale = await start(h.vera, iPhone, shown)

    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({
      error:
        "Your Build changed since this page showed it, so the review didn't start. Reload the page to see which Build is yours now.",
    })
    expect(h.deviceHost.launches).toEqual([])
    expect(storedSession(h, "vera")).toBeUndefined()
    // iPhone isn't Vera's: Noor reviews on it.
    expect((await pick(h.noor, shown)).status).toBe(200)
    expect((await start(h.noor, iPhone, shown)).status).toBe(200)
    const started = await start(h.vera, iPad, theirs)
    expect(started.status).toBe(200)
    expect(await started.json()).toMatchObject({
      status: "started",
      build: { ...nextUp, id: theirs },
    })
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
    expect((await start(after.vera, iPhone, id)).status).toBe(200)
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

describe("A delete racing a pick or an upload", () => {
  test("a pick of the Build being deleted is a 404, and the open review stays", async () => {
    const h = server()
    const reviewing = await uploaded(h, h.vera)
    expect((await start(h.vera, iPhone, reviewing)).status).toBe(200)
    const opened = storedSession(h, "vera")
    const doomed = await uploaded(h, h.noor, "NextUp")
    const read = gate()
    h.sessionReads.before = read.opened
    const deleting = remove(h.noor, doomed)
    await vi.waitFor(() => expect(h.sessionReads.held).toBe(1))

    const picking = pick(h.vera, doomed)
    await Promise.race([
      picking,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ])
    read.open()

    expect((await deleting).status).toBe(204)
    const picked = await picking
    expect(picked.status).toBe(404)
    expect(await picked.json()).toEqual({
      error: "That Build is no longer in the Build Library.",
    })
    expect(storedSession(h, "vera")).toEqual(opened)
    expect((await review(h.vera)).build).toEqual({ ...reviewMe, id: reviewing })
  })

  test("an upload whose Build is deleted before it is picked is a 404, and the open review stays", async () => {
    const h = server()
    const reviewing = await uploaded(h, h.vera)
    expect((await start(h.vera, iPhone, reviewing)).status).toBe(200)
    const opened = storedSession(h, "vera")
    // A delete of the Build under review holds the Library while it reads
    // the open sessions.
    const read = gate()
    h.sessionReads.before = read.opened
    const refusing = remove(h.noor, reviewing)
    await vi.waitFor(() => expect(h.sessionReads.held).toBe(1))
    const extraction = gate()
    let uploadedID: string | undefined
    h.runner.enqueue({
      exitCode: 0,
      effect: async (command) => {
        const contents = command.arguments[4]!
        uploadedID = contents.split("/").at(-2)
        await extraction.opened
        writeAppBundle(contents, "NextUp.app", simulatorInfoPlist())
      },
    })
    const uploading = h.vera.request("/api/build?name=NextUp.zip", {
      method: "POST",
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    await vi.waitFor(() => expect(uploadedID).toBeDefined())

    // Noor's delete of the new Build waits its turn ahead of the upload's
    // pick, which comes once the Build is in the Library.
    const deletingUpload = h.buildLibrary.delete(uploadedID!)
    extraction.open()
    await vi.waitFor(() =>
      expect(
        existsSync(join(h.libraryDirectory, uploadedID!, "entry.json"))
      ).toBe(true)
    )
    read.open()

    expect((await refusing).status).toBe(409)
    await deletingUpload
    const upload = await uploading
    expect(upload.status).toBe(404)
    expect(storedSession(h, "vera")).toEqual(opened)
    expect((await review(h.vera)).build).toEqual({ ...reviewMe, id: reviewing })
    expect((await library(h.vera)).map((build) => build.id)).toEqual([
      reviewing,
    ])
  })
})

describe("A session opened before the Library", () => {
  /**
   * Vera's open session on the Build in her own old slot, beside an older
   * slot and an upload's leftover zip.
   */
  function legacyServer({ movedFrom = "/" } = {}) {
    const h = server()
    const directory = join(h.data, "reviewers", "vera")
    const slot = join(directory, "builds", newUUID())
    const stale = join(directory, "builds", newUUID())
    const bundle = writeAppBundle(slot, "ReviewMe.app", simulatorInfoPlist())
    writeAppBundle(stale, "Older.app", simulatorInfoPlist())
    mkdirSync(join(directory, "uploads"), { recursive: true })
    writeFileSync(join(directory, "uploads", `${newUUID()}.zip`), "PK")
    writeOpenSession(
      h,
      "vera",
      `${pathToFileURL(join(movedFrom, bundle)).href}/`
    )
    return { ...h, directory, slot, stale, bundle }
  }

  test("resumes on its own Build, which isn't in the Library, and the rest of the old slots go at the first load", async () => {
    const h = legacyServer()

    const state = await review(h.vera)

    expect(state.build).toEqual(reviewMe)
    expect(state.session?.project.id).toBe("0-12")
    expect(readdirSync(join(h.directory, "builds"))).toEqual([
      h.slot.split("/").at(-1),
    ])
    expect(existsSync(join(h.directory, "uploads"))).toBe(false)
    expect(await library(h.vera)).toEqual([])
    expect((await start(h.vera, iPhone)).status).toBe(200)
    expect(launchedFrom(h)).toEqual([`${h.bundle}/`])
  })

  test("whose Build this host doesn't have, as after a move to another home, keeps every slot until it ends", async () => {
    const h = legacyServer({ movedFrom: "/Users/previous" })

    await review(h.vera)

    expect(readdirSync(join(h.directory, "builds")).sort()).toEqual(
      [h.slot, h.stale].map((slot) => slot.split("/").at(-1)).sort()
    )
    expect((await end(h.vera)).status).toBe(204)
    expect(existsSync(join(h.directory, "builds"))).toBe(false)
  })

  test("a slot that can't be deleted at the end is logged and tried again at the next load, and the review still ends", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const h = legacyServer()
    await review(h.vera)
    expect((await start(h.vera, iPhone)).status).toBe(200)
    const builds = join(h.directory, "builds")
    chmodSync(builds, 0o555)
    try {
      const ended = await end(h.vera)

      expect(ended.status).toBe(204)
      expect(storedSession(h, "vera")).toBeUndefined()
      expect(errors).toHaveBeenCalled()
      // The device went with the review: Noor reviews on it.
      const id = await uploaded(h, h.noor)
      expect((await start(h.noor, iPhone, id)).status).toBe(200)
    } finally {
      chmodSync(builds, 0o755)
      errors.mockRestore()
    }
    expect(await review(h.vera)).toEqual({ filing: { status: "idle" } })
    expect(existsSync(builds)).toBe(false)
  })

  test("once it ends, its slot is deleted and no Build is picked", async () => {
    const h = legacyServer()
    await review(h.vera)

    expect((await end(h.vera)).status).toBe(204)

    expect(existsSync(join(h.directory, "builds"))).toBe(false)
    expect(await review(h.vera)).toEqual({ filing: { status: "idle" } })
  })
})

describe("A delete racing a start", () => {
  test("is refused while the start is under way, which then opens its session", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)
    const launches = holdLaunches(h)
    const starting = start(h.vera, iPhone, id)
    await vi.waitFor(() => expect(launches.held).toEqual([iPhone.udid]))

    const duringStart = await remove(h.noor, id)
    const listed = await library(h.noor)
    launches.release()
    const started = await starting
    const afterStart = await remove(h.noor, id)

    expect(duringStart.status).toBe(409)
    expect(listed.map((build) => build.inUse)).toEqual([true])
    expect(started.status).toBe(200)
    expect(afterStart.status).toBe(409)
    expect(
      existsSync(fileURLToPath(storedSession(h, "vera")!.build.appBundleURL))
    ).toBe(true)
  })

  test("a start that saves its session while a delete reads the open sessions keeps its Build", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)
    const launches = holdLaunches(h)
    const starting = start(h.vera, iPhone, id)
    await vi.waitFor(() => expect(launches.held).toEqual([iPhone.udid]))
    const read = gate()
    h.sessionReads.after = read.opened
    const deleting = remove(h.noor, id)
    await vi.waitFor(() => expect(h.sessionReads.held).toBe(1))

    // The delete found no session of Vera's: hers is saved only now, and
    // her start lets go of the Build once it is.
    launches.release()
    const started = await starting
    read.open()
    const deleted = await deleting

    expect(started.status).toBe(200)
    expect(deleted.status).toBe(409)
    expect(
      existsSync(fileURLToPath(storedSession(h, "vera")!.build.appBundleURL))
    ).toBe(true)
    expect((await library(h.noor)).map((build) => build.id)).toEqual([id])
  })

  test("the Library is held while a delete checks its Build: the start waits, then finds the Build gone", async () => {
    const h = server()
    const id = await uploaded(h, h.vera)
    const read = gate()
    h.sessionReads.before = read.opened
    const deleting = remove(h.noor, id)
    await vi.waitFor(() => expect(h.sessionReads.held).toBe(1))

    const starting = start(h.vera, iPhone, id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const launchedMeanwhile = h.deviceHost.launches.length
    read.open()

    expect(launchedMeanwhile).toBe(0)
    expect((await deleting).status).toBe(204)
    const started = await starting
    expect(started.status).toBe(409)
    expect(await started.json()).toEqual({
      error: "That Build was deleted from the Build Library. Pick another one.",
    })
    expect(h.deviceHost.launches).toEqual([])
    expect(storedSession(h, "vera")).toBeUndefined()
  })
})
