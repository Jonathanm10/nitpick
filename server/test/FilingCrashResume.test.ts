// Not a port. Issue 08's acceptance criterion as it reads: the real server
// process is killed mid-ladder and started again, and filing resumes without
// duplicating any Issue, attachment or tag. The server runs as `pnpm start`
// runs it, against a fake YouTrack on loopback.
import { spawn, type ChildProcess } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { newUUID, type ReviewSession } from "@nitpick/core"
import { afterEach, expect, test } from "vitest"
import {
  goldenInput,
  sessionFrom,
  type SessionAndFinding,
} from "../../core/test/golden.ts"
import type { ReviewStateResponse } from "../src/api.ts"
import { ReviewerStore } from "../src/reviewerStore.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeYouTrack } from "./FakeYouTrack.ts"

const mainScript = new URL("../src/main.ts", import.meta.url).pathname
const capture = readFileSync(
  new URL("../../core/test/golden/images/capture.png", import.meta.url)
)
const golden = goldenInput<SessionAndFinding>(
  "issue-description/with-designer-text.input.json"
)

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  await new Promise((resolve) => server.close(resolve))
  if (address === null || typeof address === "string") throw new Error()
  return address.port
}

/** `pnpm start`, with only the config this test gives it. */
function startServer(environment: Record<string, string>): ChildProcess {
  const server = spawn(process.execPath, [mainScript], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  cleanups.push(() => server.kill("SIGKILL"))
  return server
}

async function until<T>(
  read: () => Promise<T | undefined>,
  what: string
): Promise<T> {
  for (let tries = 0; tries < 600; tries++) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

test(
  "killing the server mid-ladder and starting it again files the rest exactly once",
  { timeout: 60_000 },
  async () => {
    const fake = new FakeYouTrack()
    const youTrack = await fake.listen()
    cleanups.push(() => youTrack.close())

    // The interim Reviewer's open session: two Findings, nothing filed.
    const data = temporaryDirectory()
    const store = new ReviewerStore(join(data, "reviewers", "interim"))
    const session: ReviewSession = {
      ...sessionFrom(golden.session),
      tray: ["Button color is off", "Label truncates"].map((summary) => ({
        id: newUUID(),
        finding: { ...golden.finding, summary },
        filingProgress: { state: "notStarted" },
      })),
    }
    for (const item of session.tray) await store.writeCapture(item.id, capture)
    await store.saveOpenSession(session)

    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const environment = {
      NITPICK_DATA_DIR: data,
      NITPICK_HOST: "127.0.0.1",
      NITPICK_PORT: String(port),
      NITPICK_YOUTRACK_URL: youTrack.url,
      NITPICK_YOUTRACK_TOKEN: "perm:vera",
    }
    const review = async () =>
      (await (await fetch(`${base}/api/review`)).json()) as ReviewStateResponse

    // The first server dies the moment the second Issue's design-review tag
    // reaches YouTrack: that request is never answered, so never applied.
    const first = startServer(environment)
    const exited = new Promise((resolve) => first.once("exit", resolve))
    let tagRequests = 0
    fake.intercept = (request) => {
      if (
        !/^api\/issues\/[^/]+\/tags$/.test(request.path) ||
        ++tagRequests !== 3
      )
        return
      first.kill("SIGKILL")
      return new Promise<void>(() => {})
    }
    await until(review, "the first server")
    const started = await fetch(`${base}/api/session/filing`, {
      method: "POST",
    })
    expect(started.status).toBe(202)
    await exited
    expect(fake.issues.map((issue) => issue.tags)).toEqual([
      ["design-review", "nitpick-type:bug"],
      [],
    ])
    expect(await store.isMarkedFiling()).toBe(true)

    // The second server resumes on its own, from the marks on disk.
    // Slowed, so the run is still going when the port first answers.
    fake.intercept = () =>
      new Promise<void>((resolve) => setTimeout(resolve, 100))
    startServer(environment)
    const firstAnswer = await until(review, "the second server")
    expect(firstAnswer.filing.status).toBe("running")
    const filed = await until(async () => {
      const { filing } = await review()
      return filing.status === "filed" ? filing : undefined
    }, "the resumed run")

    const answered = (pattern: RegExp) => fake.answered("POST", pattern).length
    expect({
      issues: answered(/^api\/issues$/),
      attachmentUploads: answered(/^api\/issues\/[^/]+\/attachments$/),
      tagsApplied: answered(/^api\/issues\/[^/]+\/tags$/),
    }).toEqual({ issues: 2, attachmentUploads: 2, tagsApplied: 4 })
    expect(
      fake.issues.map((issue) => ({
        files: issue.attachments.map((file) => file.fileName),
        tags: issue.tags,
      }))
    ).toEqual([
      {
        files: ["annotated.png", "original.png"],
        tags: ["design-review", "nitpick-type:bug"],
      },
      {
        files: ["annotated.png", "original.png"],
        tags: ["design-review", "nitpick-type:bug"],
      },
    ])
    expect(
      filed.result.findings.map((finding) => finding.issue.idReadable)
    ).toEqual(["RM-101", "RM-102"])
    expect(readdirSync(join(data, "history"))).toHaveLength(1)
    expect(await store.openSession()).toBeUndefined()
  }
)
