// Not a port: the Swift app had one user and a Keychain. Issue 10's
// acceptance criteria as they read, in process against the route-answering
// fake YouTrack: the auth matrix over every route the app registers,
// sign-in, a token YouTrack rejects later, sign-out, two Reviewers at once,
// a restart, the sliding expiry, and where the token may never show. All
// users and tokens are fictional.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { inspect } from "node:util"
import {
  newUUID,
  webFeedbackEnvironment,
  type ReviewSession,
} from "@nitpick/core"
import { describe, expect, test, vi } from "vitest"
import {
  goldenInput,
  sessionFrom,
  type SessionAndFinding,
} from "../../core/test/golden.ts"
import type {
  HistoryResponse,
  ReviewStateResponse,
  SignedInResponse,
} from "../src/api.ts"
import { createApp } from "../src/app.ts"
import { DeviceClaims } from "../src/device/deviceClaims.ts"
import { HistoryStore } from "../src/historyStore.ts"
import { ReviewerStore } from "../src/reviewerStore.ts"
import {
  rejectedTokenMessage,
  Reviewers,
  signInCookieName,
} from "../src/reviewers.ts"
import { SignInStore } from "../src/signInStore.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeDeviceHost } from "./FakeDeviceHost.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"
import { FakeYouTrack } from "./FakeYouTrack.ts"

const capture = readFileSync(
  new URL("../../core/test/golden/images/capture.png", import.meta.url)
)
const golden = goldenInput<SessionAndFinding>(
  "issue-description/with-designer-text.input.json"
)
const vera = { login: "vera", fullName: "Vera Baumann" }
const noor = { login: "noor", fullName: "Noor Haddad" }
const day = 24 * 60 * 60 * 1000
const iPhone = {
  udid: "AAAA-1111",
  name: "iPhone 17 Pro",
  osName: "iOS 26.5",
  isBooted: true,
  isRuntimeAvailable: true,
}

function server(
  options: {
    readonly data?: string
    readonly fake?: FakeYouTrack
    readonly now?: () => number
  } = {}
) {
  const data = options.data ?? temporaryDirectory()
  const fake = options.fake ?? new FakeYouTrack()
  const signIns = new SignInStore(data, fake.instanceURL, { now: options.now })
  const history = new HistoryStore(join(data, "history"))
  const deviceHost = new FakeDeviceHost([iPhone])
  const reviewers = new Reviewers({
    directory: join(data, "reviewers"),
    instanceURL: fake.instanceURL,
    transport: fake.transport,
    signIns,
    dependencies: {
      deviceHost,
      runner: new FakeSubprocessRunner(),
      history,
      deviceClaims: new DeviceClaims({
        limit: undefined,
        list: deviceHost.devices.list,
        shutDown: deviceHost.shutDown,
      }),
    },
  })
  const app = createApp({
    deviceHost,
    reviewers,
    history,
    serverVersion: "0.0.0",
  })
  return { app, data, fake, signIns, reviewers }
}

type Server = ReturnType<typeof server>

function signIn({ app }: Server, token: string, headers = {}) {
  return app.request("/api/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ token }),
  })
}

/** The `Cookie` header a browser sends back after `response`. */
function cookieOf(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0]!
}

async function signedIn(h: Server, token: string): Promise<string> {
  const response = await signIn(h, token)
  expect(response.status).toBe(200)
  return cookieOf(response)
}

function get({ app }: Server, path: string, cookie: string) {
  return app.request(path, { headers: { cookie } })
}

async function review(h: Server, cookie: string) {
  return (await (
    await get(h, "/api/review", cookie)
  ).json()) as ReviewStateResponse
}

/** An open session on disk for `login`, each Finding with a capture. */
async function stage(
  { data }: Server,
  login: string,
  summaries: ReadonlyArray<string>
): Promise<ReviewSession> {
  const store = new ReviewerStore(join(data, "reviewers", login))
  const session: ReviewSession = {
    ...sessionFrom(golden.session),
    tray: summaries.map((summary) => ({
      id: newUUID(),
      finding: { ...golden.finding, summary },
      filingProgress: { state: "notStarted" },
    })),
  }
  for (const item of session.tray) await store.writeCapture(item.id, capture)
  await store.saveOpenSession(session)
  return session
}

async function fileAll(h: Server, login: string, cookie: string) {
  const started = await h.app.request("/api/session/filing", {
    method: "POST",
    headers: { cookie },
  })
  expect(started.status).toBe(202)
  const reviewer = h.reviewers.reviewer(login)
  for (let tries = 0; reviewer.filingStatus().status === "running"; tries++) {
    if (tries > 2000) throw new Error("File all never ended")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return reviewer.filingStatus()
}

function sendFeedback({ app }: Server, cookie: string, title: string) {
  const form = new FormData()
  form.set(
    "feedback",
    JSON.stringify({
      kind: "bug",
      title,
      description: "",
      environment: webFeedbackEnvironment({
        webApp: "0.0.1",
        server: "0.0.0",
        browser: "Chrome 131 on macOS",
      }),
    })
  )
  return app.request("/api/feedback", {
    method: "POST",
    headers: { cookie },
    body: form,
  })
}

function signInFiles({ data }: Server): string[] {
  try {
    return readdirSync(join(data, "sign-ins"))
  } catch {
    return []
  }
}

const udid = "C0FFEE00-0000-4000-8000-000000000010"

/** Every route the app registers, as `METHOD path`, and how to call it. */
const registeredRoutes = [
  "POST /api/sign-in",
  "POST /api/sign-out",
  "GET /api/sign-in",
  "GET /api/sign-in/youtrack",
  "GET /api/sign-in/youtrack/callback",
  "ALL /api/device-hub/*",
  "GET /api/me",
  "GET /api/devices",
  "GET /api/host",
  "GET /api/projects",
  "GET /api/review",
  "POST /api/session/filing",
  "DELETE /api/filing-result",
  "GET /api/history",
  "POST /api/history/import",
  "GET /api/feedback/environment",
  "POST /api/build",
  "POST /api/session",
  "PUT /api/session/device",
  "DELETE /api/session",
  "PATCH /api/session",
  "POST /api/session/captures",
  "PATCH /api/session/findings/:itemID",
  "DELETE /api/session/findings/:itemID",
  "GET /api/session/findings/:itemID/capture",
  "POST /api/feedback",
  "POST /api/session/findings/:itemID/design-snapshots",
  "PUT /api/session/findings/:itemID/design-snapshots/:snapshotID",
  "PATCH /api/session/findings/:itemID/design-snapshots/:snapshotID",
  "DELETE /api/session/findings/:itemID/design-snapshots/:snapshotID",
  "GET /api/session/findings/:itemID/design-snapshot-data/:dataVersion",
  "GET /api/label-sprite",
  "POST /api/device-stream",
]

/** The routes that sign in and out, which need no sign-in themselves. */
const signInRoutes = new Set(
  registeredRoutes.filter((route) => /^\w+ \/api\/sign-(in|out)\b/.test(route))
)

/** A request a route answers: its parameters filled in, a real stream path. */
function sampleRequest(route: string): { method: string; path: string } {
  const [method, path] = route.split(" ") as [string, string]
  return {
    method: method === "ALL" ? "GET" : method,
    path:
      path === "/api/device-hub/*"
        ? `/api/device-hub/vendor/serve-sim/helper/${udid}/stream.mjpeg`
        : path.replace(/:\w+/g, "x"),
  }
}

describe("the auth matrix", () => {
  test("every route the app registers refuses a request without a live sign-in, and admits one with it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const h = server()
    const live = await signedIn(h, "perm:vera")
    const ended = await signedIn(h, "perm:noor")
    await h.app.request("/api/sign-out", {
      method: "POST",
      headers: { cookie: ended },
    })
    const credentials: Record<string, Record<string, string>> = {
      none: {},
      forged: { cookie: `${signInCookieName}=forged` },
      unissued: { cookie: `${signInCookieName}=${"A".repeat(43)}` },
      "signed out": { cookie: ended },
      "token as Bearer": { authorization: "Bearer perm:vera" },
    }

    const registered = new Set(
      h.app.routes
        .map((route) => `${route.method} ${route.path}`)
        .filter((route) => route !== "ALL /api/*")
    )
    expect(registered).toEqual(new Set(registeredRoutes))

    for (const route of registeredRoutes) {
      if (signInRoutes.has(route)) continue
      const { method, path } = sampleRequest(route)
      for (const [name, headers] of Object.entries(credentials)) {
        const response = await h.app.request(path, { method, headers })
        expect(response.status, `${route} with ${name}`).toBe(401)
      }
      const admitted = await h.app.request(path, {
        method,
        headers: { cookie: live },
      })
      expect(admitted.status, `${route} signed in`).not.toBe(401)
    }
  })

  test("a request from another origin can't change anything, sign-in included", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const cookie = await signedIn(h, "perm:vera")
    const foreign = { host: "nitpick.test", origin: "http://nitpick.test:5999" }

    const signInFromAfar = await signIn(h, "perm:noor", foreign)
    const endFromAfar = await h.app.request("/api/session", {
      method: "DELETE",
      headers: { ...foreign, cookie },
    })
    const endHere = await h.app.request("/api/session", {
      method: "DELETE",
      headers: { host: "nitpick.test", origin: "http://nitpick.test", cookie },
    })

    expect([signInFromAfar.status, endFromAfar.status]).toEqual([403, 403])
    expect(signInFromAfar.headers.get("set-cookie")).toBeNull()
    expect(endHere.status).toBe(204)
  })
})

describe("signing in", () => {
  test("the right token signs in its YouTrack user with an HttpOnly, SameSite=Lax cookie that holds a random ID, never the token", async () => {
    const h = server()

    const response = await signIn(h, "  perm:vera\n")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reviewer: vera,
    } satisfies SignedInResponse)
    const setCookie = response.headers.get("set-cookie")!
    expect(setCookie).toMatch(
      /^nitpick_sign_in=[A-Za-z0-9_-]{43}; Path=\/api; Max-Age=2592000; HttpOnly; SameSite=Lax$/
    )
    expect(setCookie).not.toContain("vera")
    expect(h.fake.requests.map((request) => request.path)).toEqual([
      "api/users/me",
    ])
    const me = await get(h, "/api/me", cookieOf(response))
    expect(await me.json()).toEqual({ reviewer: vera })
  })

  test.each([
    [
      "a wrong or revoked token",
      "perm:nobody",
      401,
      /YouTrack rejected the token/,
    ],
    ["an empty token", "  ", 400, /^Paste your YouTrack permanent token\.$/],
  ])(
    "%s gets a clear error and no sign-in",
    async (_, token, status, error) => {
      const h = server()

      const response = await signIn(h, token)

      expect(response.status).toBe(status)
      expect(((await response.json()) as { error: string }).error).toMatch(
        error
      )
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(signInFiles(h)).toEqual([])
    }
  )

  test("YouTrack out of reach gets 502 and no sign-in", async () => {
    const h = server()
    h.fake.intercept = () => {
      throw new TypeError("fetch failed")
    }

    const response = await signIn(h, "perm:vera")

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error:
        "YouTrack couldn't be reached, so the token couldn't be checked. Try again later.",
    })
    expect(signInFiles(h)).toEqual([])
  })

  test("signing in again in the same browser ends the sign-in it held", async () => {
    const h = server()
    const first = await signedIn(h, "perm:vera")

    const second = await signIn(h, "perm:noor", { cookie: first })

    expect((await get(h, "/api/me", first)).status).toBe(401)
    expect(await (await get(h, "/api/me", cookieOf(second))).json()).toEqual({
      reviewer: noor,
    })
    expect(signInFiles(h)).toHaveLength(1)
  })
})

describe("the token at rest", () => {
  test("is sealed under a 0600 key file, in a 0600 file that names neither the token nor the cookie's ID", async () => {
    const h = server()
    const cookie = await signedIn(h, "perm:vera")
    const id = cookie.slice(`${signInCookieName}=`.length)

    const [name] = signInFiles(h)
    const file = join(h.data, "sign-ins", name!)
    const stored = readFileSync(file, "utf8")
    const mode = (path: string) => statSync(path).mode & 0o777

    expect(mode(join(h.data, "sign-in-key"))).toBe(0o600)
    expect(mode(file)).toBe(0o600)
    expect(mode(join(h.data, "sign-ins"))).toBe(0o700)
    expect(statSync(join(h.data, "sign-in-key")).size).toBe(32)
    expect(stored).toContain('"login":"vera"')
    expect(stored).not.toContain("perm:vera")
    expect(name).not.toContain(id)
    expect(stored).not.toContain(id)
  })

  test("a restart reads the sign-in back and files with its token", async () => {
    const data = temporaryDirectory()
    const fake = new FakeYouTrack()
    const cookie = await signedIn(server({ data, fake }), "perm:vera")

    const restarted = server({ data, fake })
    await restarted.signIns.load()
    const projects = await get(restarted, "/api/projects", cookie)

    expect(projects.status).toBe(200)
    expect(fake.requests.at(-1)?.path).toBe("api/admin/projects")
  })

  test.each([
    [
      "another key file",
      ({ data }: Server) =>
        writeFileSync(join(data, "sign-in-key"), Buffer.alloc(32, 7), {
          mode: 0o600,
        }),
    ],
    [
      "a tampered file",
      ({ data }: Server) => {
        const directory = join(data, "sign-ins")
        const [name] = readdirSync(directory)
        const path = join(directory, name!)
        const stored = JSON.parse(readFileSync(path, "utf8")) as {
          login: string
        }
        writeFileSync(path, JSON.stringify({ ...stored, login: "noor" }))
      },
    ],
  ])(
    "after a restart, a sign-in that doesn't open with %s is dropped",
    async (_, change) => {
      const data = temporaryDirectory()
      const fake = new FakeYouTrack()
      const first = server({ data, fake })
      const cookie = await signedIn(first, "perm:vera")
      change(first)

      const restarted = server({ data, fake })
      await restarted.signIns.load()

      expect((await get(restarted, "/api/me", cookie)).status).toBe(401)
      expect(signInFiles(restarted)).toEqual([])
    }
  )

  test("after a restart against another YouTrack instance, the token never goes there", async () => {
    const data = temporaryDirectory()
    const cookie = await signedIn(server({ data }), "perm:vera")
    const elsewhere = new FakeYouTrack("https://youtrack.other.example/yt")

    const restarted = server({ data, fake: elsewhere })
    await restarted.signIns.load()

    expect((await get(restarted, "/api/projects", cookie)).status).toBe(401)
    expect(elsewhere.requests).toEqual([])
  })

  test("a key file others can read is refused, as ssh refuses such a key", async () => {
    const h = server()
    await signedIn(h, "perm:vera")
    await chmod(join(h.data, "sign-in-key"), 0o644)

    await expect(
      new SignInStore(h.data, h.fake.instanceURL).load()
    ).rejects.toThrow(/can be read by other users.*chmod 600/)
  })
})

describe("the sliding expiry", () => {
  test("a sign-in in use lasts; a month unused ends it", async () => {
    let now = Date.UTC(2026, 9, 28)
    const h = server({ now: () => now })
    const cookie = await signedIn(h, "perm:vera")
    const expiry = () => {
      const [name] = signInFiles(h)
      return (
        JSON.parse(readFileSync(join(h.data, "sign-ins", name!), "utf8")) as {
          expiresAt: number
        }
      ).expiresAt
    }

    now += 2 * day
    const renewed = await get(h, "/api/review", cookie)
    now += 29 * day
    const stillIn = await get(h, "/api/review", cookie)
    const lastUse = now
    now += 30 * day

    expect(renewed.status).toBe(200)
    expect(renewed.headers.get("set-cookie")).toBe(
      `${cookie}; Path=/api; Max-Age=2592000; HttpOnly; SameSite=Lax`
    )
    expect(stillIn.status).toBe(200)
    expect(stillIn.headers.get("set-cookie")).not.toBeNull()
    expect(expiry()).toBe(lastUse + 30 * day)
    expect((await get(h, "/api/review", cookie)).status).toBe(401)
    await vi.waitFor(() => expect(signInFiles(h)).toEqual([]))
  })
})

describe("a token YouTrack rejects later", () => {
  test("sends the Reviewer back to sign-in with a clear message, and keeps the open session for the next sign-in", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off", "Label truncates"])
    const cookie = await signedIn(h, "perm:vera")
    delete h.fake.users["perm:vera"]

    const projects = await get(h, "/api/projects", cookie)
    const next = await get(h, "/api/review", cookie)

    expect(projects.status).toBe(401)
    expect(await projects.json()).toEqual({
      error: rejectedTokenMessage,
      code: "signIn",
    })
    expect(projects.headers.get("set-cookie")).toBe(
      `${signInCookieName}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax`
    )
    expect(await next.json()).toEqual({
      error: rejectedTokenMessage,
      code: "signIn",
    })
    expect(signInFiles(h)).toEqual([])

    h.fake.users["perm:vera-renewed"] = vera
    const again = await signedIn(h, "perm:vera-renewed")
    const restored = await review(h, again)
    expect(restored.session?.tray.map((item) => item.finding.summary)).toEqual([
      "Button color is off",
      "Label truncates",
    ])
  })

  test("on Resume review, whose project schema read is otherwise non-fatal, ends the sign-in too", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const cookie = await signedIn(h, "perm:vera")
    delete h.fake.users["perm:vera"]

    const resume = await h.app.request("/api/session", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceUDID: iPhone.udid }),
    })

    expect(resume.status).toBe(401)
    expect(await resume.json()).toEqual({
      error: rejectedTokenMessage,
      code: "signIn",
    })
    expect(signInFiles(h)).toEqual([])
  })

  test("in a File all running on the server ends the sign-in too; the session stays to file again", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const cookie = await signedIn(h, "perm:vera")
    delete h.fake.users["perm:vera"]

    const ending = await fileAll(h, "vera", cookie)
    const next = await get(h, "/api/review", cookie)

    expect(ending).toMatchObject({ status: "failed" })
    expect(next.status).toBe(401)
    expect(await next.json()).toEqual({
      error: rejectedTokenMessage,
      code: "signIn",
    })
    const store = new ReviewerStore(join(h.data, "reviewers", "vera"))
    expect((await store.openSession())?.tray).toHaveLength(1)
  })
})

describe("signing out", () => {
  test("ends the sign-in and deletes its token; the open session is there at the next sign-in", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const cookie = await signedIn(h, "perm:vera")

    const signOut = await h.app.request("/api/sign-out", {
      method: "POST",
      headers: { cookie },
    })

    expect(signOut.status).toBe(204)
    expect(signOut.headers.get("set-cookie")).toBe(
      `${signInCookieName}=; Path=/api; Max-Age=0; HttpOnly; SameSite=Lax`
    )
    expect(signInFiles(h)).toEqual([])
    expect(await (await get(h, "/api/review", cookie)).json()).toEqual({
      error: "Sign in to continue.",
      code: "signIn",
    })
    const again = await signedIn(h, "perm:vera")
    expect(
      (await review(h, again)).session?.tray.map((item) => item.finding.summary)
    ).toEqual(["Button color is off"])
  })
})

describe("two Reviewers signed in at once", () => {
  test("each sees their own open session, files as themselves, and sees only their own History", async () => {
    const h = server()
    await stage(h, "vera", ["Vera's button color"])
    await stage(h, "noor", ["Noor's truncated label", "Noor's misaligned icon"])
    const veraCookie = await signedIn(h, "perm:vera")
    const noorCookie = await signedIn(h, "perm:noor")
    const summaries = async (cookie: string) =>
      (await review(h, cookie)).session?.tray.map(
        (item) => item.finding.summary
      )

    expect(await summaries(veraCookie)).toEqual(["Vera's button color"])
    expect(await summaries(noorCookie)).toEqual([
      "Noor's truncated label",
      "Noor's misaligned icon",
    ])

    expect(await fileAll(h, "vera", veraCookie)).toMatchObject({
      status: "filed",
    })
    expect(await fileAll(h, "noor", noorCookie)).toMatchObject({
      status: "filed",
    })
    expect((await sendFeedback(h, veraCookie, "Vera's feedback")).status).toBe(
      200
    )
    expect((await sendFeedback(h, noorCookie, "Noor's feedback")).status).toBe(
      200
    )

    expect(
      h.fake.issues.map((issue) => [issue.summary, issue.reporter])
    ).toEqual([
      ["Vera's button color", "vera"],
      ["Noor's truncated label", "noor"],
      ["Noor's misaligned icon", "noor"],
      ["Vera's feedback", "vera"],
      ["Noor's feedback", "noor"],
    ])
    for (const [cookie, reviewer] of [
      [veraCookie, vera],
      [noorCookie, noor],
    ] as const) {
      const history = (await (
        await get(h, "/api/history", cookie)
      ).json()) as HistoryResponse
      expect(history.reviewer).toEqual(reviewer)
      expect(history.entries.map((entry) => entry.filedBy?.login)).toEqual([
        reviewer.login,
      ])
    }
  })

  test("a login is one folder of its own, whatever its characters", async () => {
    const h = server()
    h.fake.users["perm:dots"] = { login: "..", fullName: "Dot Dot" }
    h.fake.users["perm:slash"] = { login: "a/b", fullName: "A B" }
    await stage(h, "%2E%2E", ["Dots' Finding"])
    await stage(h, "a%2Fb", ["Slash's Finding"])

    for (const [token, summary] of [
      ["perm:dots", "Dots' Finding"],
      ["perm:slash", "Slash's Finding"],
    ]) {
      const cookie = await signedIn(h, token!)
      expect(
        (await review(h, cookie)).session?.tray.map(
          (item) => item.finding.summary
        )
      ).toEqual([summary])
    }
  })
})

describe("the token never shows", () => {
  test("in responses, cookies, logs, or the server's objects, whatever happens", async () => {
    const lines: string[] = []
    for (const method of ["log", "error", "warn", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => inspect(arg, { depth: 8 })).join(" "))
      })
    }
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const answers: string[] = []
    const keep = async (response: Response) => {
      answers.push(
        JSON.stringify([...response.headers]),
        await response.clone().text()
      )
      return response
    }

    const cookie = cookieOf(await keep(await signIn(h, "perm:vera")))
    await keep(await signIn(h, "perm:not-a-real-token"))
    for (const path of ["/api/me", "/api/review", "/api/projects"]) {
      await keep(await get(h, path, cookie))
    }
    h.fake.intercept = () => ({ status: 500 })
    await keep(await get(h, "/api/projects", cookie))
    h.fake.intercept = () => undefined
    delete h.fake.users["perm:vera"]
    await fileAll(h, "vera", cookie)
    await keep(await get(h, "/api/review", cookie))
    await keep(await get(h, "/api/projects", cookie))

    const everything = [
      ...answers,
      ...lines,
      inspect(h.signIns, { depth: Infinity, showHidden: true }),
      inspect(h.reviewers, { depth: Infinity, showHidden: true }),
    ].join("\n")
    expect(everything).not.toMatch(/perm:vera|perm:not-a-real-token/)
  })
})
