// File all, the filing result and the shared History, end to end in process
// against a fake YouTrack that answers by route. Not a port: the Swift
// shell's fileAllFindings had no tests of its own, and core's ladder cases
// are core/test's. These pin issue 08's acceptance criteria: the golden
// description and the capture bytes reach the Issue unchanged, a restart
// mid-ladder resumes without repeating a step, and the result is the
// Reviewer's own session even when History's newest entry is not.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  newUUID,
  type Finding,
  type HistoryEntry,
  type ReviewSession,
} from "@nitpick/core"
import { describe, expect, test } from "vitest"
import {
  goldenInput,
  goldenText,
  sessionFrom,
  type SessionAndFinding,
} from "../../core/test/golden.ts"
import type {
  FilingResponse,
  HistoryResponse,
  ReviewStateResponse,
} from "../src/api.ts"
import { DeviceClaims } from "../src/device/deviceClaims.ts"
import { HistoryStore } from "../src/historyStore.ts"
import { ReviewerStore } from "../src/reviewerStore.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeYouTrack } from "./FakeYouTrack.ts"
import { signedInApp } from "./SignedIn.ts"

const capture = readFileSync(
  new URL("../../core/test/golden/images/capture.png", import.meta.url)
)
const golden = goldenInput<SessionAndFinding>(
  "issue-description/with-designer-text.input.json"
)

/** One Reviewer's server over a data directory another may share. */
function reviewerOn(
  dataDirectory: string,
  fake: FakeYouTrack,
  {
    login = "vera",
    deviceClaims,
  }: { readonly login?: string; readonly deviceClaims?: DeviceClaims } = {}
) {
  const signedIn = signedInApp({
    data: dataDirectory,
    deviceHost: new FakeDeviceHost([]),
    transport: fake.transport,
    instanceURL: fake.instanceURL,
    user: fake.users[`perm:${login}`],
    serverVersion: "0.0.0 (test)",
    deviceClaims,
  })
  return { ...signedIn, store: new ReviewerStore(signedIn.directory) }
}

type Harness = ReturnType<typeof reviewerOn>

/** Puts an open session on disk, each Finding with the golden capture. */
async function stage(
  { store }: Harness,
  findings: ReadonlyArray<Partial<Finding>>,
  startedAt = golden.session.startedAt.secondsSinceReferenceDate
): Promise<ReviewSession> {
  const session: ReviewSession = {
    ...sessionFrom(golden.session),
    startedAt,
    tray: findings.map((fields) => ({
      id: newUUID(),
      finding: { ...golden.finding, ...fields },
      filingProgress: { state: "notStarted" },
    })),
  }
  for (const item of session.tray) await store.writeCapture(item.id, capture)
  await store.saveOpenSession(session)
  return session
}

async function fileAll({ app }: Harness) {
  return app.request("/api/session/filing", { method: "POST" })
}

async function review({ app }: Harness): Promise<ReviewStateResponse> {
  return (await (
    await app.request("/api/review")
  ).json()) as ReviewStateResponse
}

/** Waits out the run the route started without waiting for it. */
async function settled({ reviewer }: Harness) {
  for (let tries = 0; reviewer.filingStatus().status === "running"; tries++) {
    if (tries > 2000) throw new Error("File all never ended")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return reviewer.filingStatus()
}

const creates = (fake: FakeYouTrack) => fake.answered("POST", /^api\/issues$/)
const attaches = (fake: FakeYouTrack) =>
  fake.answered("POST", /^api\/issues\/[^/]+\/attachments$/)
const tagsApplied = (fake: FakeYouTrack) =>
  fake.answered("POST", /^api\/issues\/[^/]+\/tags$/)

describe("File all", () => {
  test("starts on the server and answers at once with the run going", async () => {
    const h = reviewerOn(temporaryDirectory(), new FakeYouTrack())
    await stage(h, [{}])

    const response = await fileAll(h)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      filing: { status: "running" },
    } satisfies FilingResponse)
    await settled(h)
  })

  test("files the golden Finding: its description byte for byte, its capture as original.png", async () => {
    const fake = new FakeYouTrack()
    const h = reviewerOn(temporaryDirectory(), fake)
    await stage(h, [{}])

    await fileAll(h)
    await settled(h)

    const [issue] = fake.issues
    expect(fake.issues).toHaveLength(1)
    expect(issue.summary).toBe("Button color is off")
    expect(issue.description).toBe(
      goldenText("issue-description/with-designer-text.txt")
    )
    expect(
      Buffer.from(issue.description).equals(
        readFileSync(
          new URL(
            "../../core/test/golden/issue-description/with-designer-text.txt",
            import.meta.url
          )
        )
      )
    ).toBe(true)
    expect(issue.attachments.map((file) => file.fileName)).toEqual([
      "annotated.png",
      "original.png",
    ])
    expect(issue.attachments[1].data.equals(capture)).toBe(true)
    expect(issue.tags).toEqual(["design-review", "nitpick-type:bug"])
  })

  test("a filed session goes to the shared History as its filer's, and the open slot with its captures is gone", async () => {
    const fake = new FakeYouTrack()
    const h = reviewerOn(temporaryDirectory(), fake)
    const session = await stage(h, [{}, { summary: "Label truncates" }])

    await fileAll(h)
    await settled(h)

    const entry: HistoryEntry = {
      build: session.build.identity,
      project: session.project,
      startedAt: session.startedAt,
      findings: fake.issues.map((issue, index) => ({
        summary: session.tray[index].finding.summary,
        description: session.tray[index].finding.description,
        deviceContext: session.tray[index].finding.deviceContext,
        // Frozen at creation from the session's own reference.
        designReference: session.designReference,
        issue: {
          idReadable: issue.idReadable,
          url: `${fake.instanceURL}/issue/${issue.idReadable}`,
        },
      })),
      filedBy: { login: "vera", fullName: "Vera Baumann" },
    }
    expect(await review(h)).toEqual({
      build: {
        name: "ReviewMe",
        identity: session.build.identity,
        platform: "ios",
      },
      filing: { status: "filed", result: entry },
    })
    expect(await (await h.app.request("/api/history")).json()).toEqual({
      entries: [entry],
      reviewer: { login: "vera", fullName: "Vera Baumann" },
    } satisfies HistoryResponse)
    expect(existsSync(join(h.directory, "open-session"))).toBe(false)
  })

  test("a filed session gives its device up to the next Reviewer", async () => {
    const fake = new FakeYouTrack()
    const iPhone = {
      udid: "AAAA-1111",
      name: "iPhone 17 Pro",
      osName: "iOS 26.5",
      isBooted: true,
      isRuntimeAvailable: true,
    }
    const iPad = { ...iPhone, udid: "DDDD-4444", name: "iPad (A16)" }
    const host = new FakeDeviceHost([iPhone, { ...iPad, isBooted: false }])
    const deviceClaims = new DeviceClaims({
      limit: 1,
      list: host.devices.list,
      shutDown: host.shutDown,
    })
    const h = reviewerOn(temporaryDirectory(), fake, { deviceClaims })
    await stage(h, [{}])
    await deviceClaims.claim(fake.users["perm:vera"], iPhone)
    const noor = { login: "noor", fullName: "Noor Haddad" }
    await expect(deviceClaims.claim(noor, iPad)).rejects.toThrow(
      "Vera Baumann is using its only device"
    )

    await fileAll(h)
    expect((await settled(h)).status).toBe("filed")

    await deviceClaims.claim(noor, iPad)
    expect(host.shutdowns).toEqual([iPhone.udid])
  })

  test("a failure keeps the error for the rows, and File n remaining resumes without a second Issue", async () => {
    const fake = new FakeYouTrack()
    const h = reviewerOn(temporaryDirectory(), fake)
    await stage(h, [{}])
    let failAttach = true
    fake.intercept = (request) => {
      if (request.path.endsWith("/attachments") && failAttach) {
        failAttach = false
        return { status: 500 }
      }
      return undefined
    }

    await fileAll(h)
    const failed = await settled(h)

    expect(failed).toEqual({
      status: "failed",
      error:
        "YouTrack answered with HTTP 500. Check the instance URL, or try again later.",
    })
    const { session } = await review(h)
    expect(session?.tray[0].filingProgress).toEqual({
      state: "issueCreated",
      issueID: "2-101",
      idReadable: "RM-101",
    })

    await fileAll(h)
    expect((await settled(h)).status).toBe("filed")
    expect(creates(fake)).toHaveLength(1)
    expect(attaches(fake)).toHaveLength(1)
    expect(fake.issues[0].tags).toEqual(["design-review", "nitpick-type:bug"])
  })

  test("a rejected Priority files anyway and names it for the toast", async () => {
    const fake = new FakeYouTrack()
    fake.rejectsCustomFields = true
    const h = reviewerOn(temporaryDirectory(), fake)
    await stage(h, [{ priority: { name: "Critical" } }])

    await fileAll(h)

    expect(await settled(h)).toMatchObject({
      status: "filed",
      droppedFieldNotice:
        "Couldn’t set Priority “Critical” — set it in YouTrack by hand.",
    })
    expect(fake.issues[0].customFields).toBeUndefined()
  })

  test("while it runs, edits, a capture and a second File all are refused with the busy message", async () => {
    const fake = new FakeYouTrack()
    const h = reviewerOn(temporaryDirectory(), fake)
    const session = await stage(h, [{}])
    let release = () => {}
    fake.intercept = (request) =>
      request.path === "api/issues"
        ? new Promise<void>((resolve) => (release = resolve))
        : undefined

    await fileAll(h)
    await expect
      .poll(() =>
        fake.requests.some((request) => request.path === "api/issues")
      )
      .toBe(true)
    const busy = {
      error:
        "Nitpick was busy, so that didn’t run. Try again when the current step finishes.",
    }
    const edit = await h.app.request(
      `/api/session/findings/${session.tray[0].id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Changed mid-filing" }),
      }
    )
    const again = await fileAll(h)
    const captureResponse = await h.app.request("/api/session/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceUDID: "AAAA-1111" }),
    })

    expect([edit.status, again.status, captureResponse.status]).toEqual([
      409, 409, 409,
    ])
    expect(await edit.json()).toEqual(busy)
    expect((await review(h)).filing).toEqual({ status: "running" })
    release()
    expect((await settled(h)).status).toBe("filed")
    expect(fake.issues[0].summary).toBe("Button color is off")
  })

  test("an edit already saving when File all starts is filed with it, never overwritten", async () => {
    const fake = new FakeYouTrack()
    const h = reviewerOn(temporaryDirectory(), fake)
    const session = await stage(h, [{}])
    const itemID = session.tray[0].id
    const adding = h.reviewer.addDesignSnapshot(
      itemID,
      "Design.png",
      new Uint8Array(capture)
    )
    // File all starts the moment the edit is writing its bytes, past the
    // busy check that refuses later edits.
    const snapshots = join(h.directory, "open-session", "design-snapshots")
    while (!existsSync(snapshots)) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const run = h.reviewer.fileAll(h.account)
    await adding
    await run

    expect(h.reviewer.filingStatus().status).toBe("filed")
    expect(fake.issues[0].attachments.map((file) => file.fileName)).toEqual([
      "annotated.png",
      "original.png",
      "Design.png",
    ])
  })

  test("Done drops the result and keeps the Build for the next review", async () => {
    const h = reviewerOn(temporaryDirectory(), new FakeYouTrack())
    await stage(h, [{}])
    await fileAll(h)
    await settled(h)

    const done = await h.app.request("/api/filing-result", {
      method: "DELETE",
    })

    expect(done.status).toBe(204)
    expect(await review(h)).toEqual({
      build: {
        name: "ReviewMe",
        identity: sessionFrom(golden.session).build.identity,
        platform: "ios",
      },
      filing: { status: "idle" },
    })
  })
})

describe("The filing result", () => {
  test("is the Reviewer's own session when another Reviewer filed a later-started one first", async () => {
    const data = temporaryDirectory()
    const fake = new FakeYouTrack()
    const vera = reviewerOn(data, fake, { login: "vera" })
    const noor = reviewerOn(data, fake, { login: "noor" })
    await stage(vera, [{ summary: "Vera's Finding" }], 804_849_332)
    await stage(noor, [{ summary: "Noor's Finding" }], 804_850_000)

    await fileAll(noor)
    await settled(noor)
    await fileAll(vera)
    await settled(vera)

    const result = await review(vera)
    expect(result.filing).toMatchObject({
      status: "filed",
      result: {
        startedAt: 804_849_332,
        filedBy: { login: "vera" },
        findings: [{ summary: "Vera's Finding" }],
      },
    })
    // The store's newest entry is Noor's, which Vera's result must not take,
    // and Vera's History shows only hers.
    expect(
      (await vera.history.entries()).map((entry) => entry.filedBy?.login)
    ).toEqual(["noor", "vera"])
    const { entries } = (await (
      await vera.app.request("/api/history")
    ).json()) as HistoryResponse
    expect(entries.map((entry) => entry.filedBy?.login)).toEqual(["vera"])
  })
})

describe("A server restart mid-ladder", () => {
  test("resumes filing on the next start without repeating an Issue, attachment or tag", async () => {
    const data = temporaryDirectory()
    const fake = new FakeYouTrack()
    const before = reviewerOn(data, fake)
    await stage(before, [{}, { summary: "Label truncates" }])
    // The server dies with the second Issue's design-review tag in flight:
    // the request is never answered, so YouTrack never applied it.
    let tagRequests = 0
    fake.intercept = (request) =>
      /^api\/issues\/[^/]+\/tags$/.test(request.path) && ++tagRequests === 3
        ? new Promise<void>(() => {})
        : undefined
    void before.reviewer.fileAll(before.account)
    await expect.poll(() => tagRequests).toBe(3)
    expect(fake.issues.map((issue) => issue.tags)).toEqual([
      ["design-review", "nitpick-type:bug"],
      [],
    ])

    fake.intercept = () => undefined
    const after = reviewerOn(data, fake)
    const resumed = await after.reviewer.resumeInterruptedFiling(after.account)
    expect(after.reviewer.filingStatus()).toEqual({ status: "running" })
    await resumed?.run

    expect(after.reviewer.filingStatus().status).toBe("filed")
    expect(creates(fake)).toHaveLength(2)
    expect(attaches(fake)).toHaveLength(2)
    expect(tagsApplied(fake)).toHaveLength(4)
    expect(fake.issues.map((issue) => issue.tags)).toEqual([
      ["design-review", "nitpick-type:bug"],
      ["design-review", "nitpick-type:bug"],
    ])
    expect(fake.issues.map((issue) => issue.attachments.length)).toEqual([2, 2])
    const history = await new HistoryStore(join(data, "history")).entries()
    expect(history.map((entry) => entry.findings.length)).toEqual([2])
    expect(await after.store.isMarkedFiling()).toBe(false)
  })

  test("after the last mark but before History, the restart records History and sends nothing", async () => {
    const data = temporaryDirectory()
    const fake = new FakeYouTrack()
    const h = reviewerOn(data, fake)
    const session = await stage(h, [{}])
    await h.store.saveOpenSession({
      ...session,
      tray: session.tray.map((item) => ({
        ...item,
        filingProgress: {
          state: "filed",
          issue: { idReadable: "RM-7", url: `${fake.instanceURL}/issue/RM-7` },
        },
      })),
    })
    await h.store.markFiling()

    const restarted = reviewerOn(data, fake)
    await (
      await restarted.reviewer.resumeInterruptedFiling(restarted.account)
    )?.run

    const history = await new HistoryStore(join(data, "history")).entries()
    expect(history.map((entry) => entry.findings[0].issue.idReadable)).toEqual([
      "RM-7",
    ])
    expect(
      fake.requests.filter((request) => request.path !== "api/users/me")
    ).toEqual([])
    expect(await h.store.openSession()).toBeUndefined()
  })

  test("a run that failed leaves no mark, so a restart doesn't retry it unasked", async () => {
    const data = temporaryDirectory()
    const fake = new FakeYouTrack()
    fake.intercept = () => ({ status: 503 })
    const h = reviewerOn(data, fake)
    await stage(h, [{}])
    await h.reviewer.fileAll(h.account)
    fake.intercept = () => undefined

    const after = reviewerOn(data, fake)

    expect(
      await after.reviewer.resumeInterruptedFiling(after.account)
    ).toBeUndefined()
    expect(after.reviewer.filingStatus()).toEqual({ status: "idle" })
    expect(creates(fake)).toEqual([])
  })
})
