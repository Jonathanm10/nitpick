// Not a port: signing in through YouTrack's own login, so a Reviewer needs
// no permanent token. The authorization code flow with PKCE against the fake
// YouTrack's Hub: the way there and back, what may go wrong on it, and the
// access token renewing as it expires, across a restart. All users, codes
// and tokens are fictional.
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { inspect } from "node:util"
import { newUUID, type ReviewSession } from "@nitpick/core"
import { describe, expect, test, vi } from "vitest"
import {
  goldenInput,
  sessionFrom,
  type SessionAndFinding,
} from "../../core/test/golden.ts"
import type {
  ReviewStateResponse,
  SignedInResponse,
  SignInMethodResponse,
} from "../src/api.ts"
import { createApp } from "../src/app.ts"
import { DeviceClaims } from "../src/device/deviceClaims.ts"
import { HistoryStore } from "../src/historyStore.ts"
import { ReviewerStore } from "../src/reviewerStore.ts"
import {
  endedHubSignInMessage,
  hubSignInCookieName,
  Reviewers,
  signInCookieName,
} from "../src/reviewers.ts"
import { SignInStore } from "../src/signInStore.ts"
import { YouTrackHub } from "../src/youTrackHub.ts"
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
const hour = 60 * 60 * 1000
/** As the browser reaches nitpick. */
const host = "nitpick.test:4870"
const callback = `http://${host}/api/sign-in/youtrack/callback`

function server(
  options: {
    readonly data?: string
    readonly fake?: FakeYouTrack
    readonly clock?: { now: number }
    /** False: no Hub registration, so Reviewers sign in with a token. */
    readonly hub?: boolean
  } = {}
) {
  const data = options.data ?? temporaryDirectory()
  const fake = options.fake ?? new FakeYouTrack()
  const clock = options.clock ?? { now: Date.UTC(2026, 9, 28, 9) }
  const now = () => clock.now
  const hub =
    options.hub === false
      ? undefined
      : new YouTrackHub({
          instanceURL: fake.instanceURL,
          client: { ...fake.hubClient },
          transport: fake.transport,
          now,
        })
  const signIns = new SignInStore(data, fake.instanceURL, { now, hub })
  const history = new HistoryStore(join(data, "history"))
  const deviceHost = new FakeDeviceHost([])
  const reviewers = new Reviewers({
    directory: join(data, "reviewers"),
    instanceURL: fake.instanceURL,
    transport: fake.transport,
    signIns,
    hub,
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
  return { app, data, fake, clock, signIns, reviewers }
}

type Server = ReturnType<typeof server>

function get({ app }: Server, path: string, cookie = "") {
  return app.request(`http://${host}${path}`, { headers: { host, cookie } })
}

/** Every `Set-Cookie` of a response, as `name=value` by name. */
function cookiesOf(response: Response): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((line) => {
      const pair = line.split(";")[0]!
      return [pair.slice(0, pair.indexOf("=")), pair]
    })
  )
}

/** The Sign in with YouTrack button: Hub's login, and the cookie for back. */
async function start(h: Server) {
  const response = await get(h, "/api/sign-in/youtrack")
  expect(response.status).toBe(302)
  return {
    location: response.headers.get("location")!,
    cookie: cookiesOf(response).get(hubSignInCookieName)!,
    setCookie: response.headers.get("set-cookie")!,
  }
}

/** Back from Hub's login at `location`, in a browser holding `cookie`. */
function back(h: Server, location: string, cookie: string) {
  const url = new URL(location)
  return get(h, `${url.pathname}${url.search}`, cookie)
}

/** All the way: the Reviewer signs in at Hub as `login`; the sign-in cookie. */
async function signedIn(h: Server, login = "vera"): Promise<string> {
  const { location, cookie } = await start(h)
  const response = await back(h, h.fake.authorize(location, login), cookie)
  expect(response.headers.get("location")).toBe("/")
  return cookiesOf(response).get(signInCookieName)!
}

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
  const started = await h.app.request(`http://${host}/api/session/filing`, {
    method: "POST",
    headers: { host, cookie },
  })
  expect(started.status).toBe(202)
  const reviewer = h.reviewers.reviewer(login)
  for (let tries = 0; reviewer.filingStatus().status === "running"; tries++) {
    if (tries > 2000) throw new Error("File all never ended")
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  return reviewer.filingStatus()
}

function tokenRequests(h: Server, grant: string) {
  return h.fake.requests.filter(
    (request) =>
      request.path === "hub/api/rest/oauth2/token" &&
      new URLSearchParams(request.body.toString()).get("grant_type") === grant
  )
}

describe("the sign-in page's method", () => {
  test("is YouTrack's login once nitpick is registered with its Hub, a token otherwise", async () => {
    for (const [hub, method] of [
      [true, "youTrack"],
      [false, "token"],
    ] as const) {
      const response = await get(server({ hub }), "/api/sign-in")
      expect(response.status).toBe(200)
      expect((await response.json()) as SignInMethodResponse).toEqual({
        method,
      })
    }
  })

  test("without a registration, the YouTrack button signs no one in", async () => {
    const response = await get(server({ hub: false }), "/api/sign-in/youtrack")
    expect(response.status).toBe(400)
    expect(response.headers.get("set-cookie")).toBeNull()
  })
})

describe("signing in through YouTrack's login", () => {
  test("goes to Hub's login with PKCE and offline access, keeping the state and verifier in a cookie only the way back reads", async () => {
    const h = server()

    const { location, cookie, setCookie } = await start(h)

    const url = new URL(location)
    const [state, verifier] = cookie.split("=")[1]!.split(".")
    expect(`${url.origin}${url.pathname}`).toBe(
      `${h.fake.instanceURL}/hub/api/rest/oauth2/auth`
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "nitpick-test-client",
      redirect_uri: callback,
      scope: "YouTrack",
      state,
      request_credentials: "default",
      access_type: "offline",
      code_challenge: createHash("sha256")
        .update(verifier!)
        .digest("base64url"),
      code_challenge_method: "S256",
    })
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(setCookie).toBe(
      `${hubSignInCookieName}=${state}.${verifier}; Path=/api/sign-in/youtrack/callback; Max-Age=600; HttpOnly; SameSite=Lax`
    )
  })

  test("coming back with Hub's code signs in the user YouTrack names, who files as themselves", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const { location, cookie } = await start(h)

    const response = await back(h, h.fake.authorize(location, "vera"), cookie)

    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/")
    const cookies = cookiesOf(response)
    expect(cookies.get(hubSignInCookieName)).toBe(`${hubSignInCookieName}=`)
    const signIn = cookies.get(signInCookieName)!
    expect(signIn).toMatch(
      new RegExp(`^${signInCookieName}=[A-Za-z0-9_-]{43}$`)
    )
    expect(
      (await (await get(h, "/api/me", signIn)).json()) as SignedInResponse
    ).toEqual({ reviewer: vera })
    // nitpick's secret went in the Basic header, the verifier in the body.
    const [exchange] = tokenRequests(h, "authorization_code")
    const form = new URLSearchParams(exchange!.body.toString())
    expect(form.get("redirect_uri")).toBe(callback)
    expect(form.get("code_verifier")).toBe(cookie.split(".")[1])
    expect(form.has("client_secret")).toBe(false)

    expect(await fileAll(h, "vera", signIn)).toMatchObject({ status: "filed" })
    expect(h.fake.issues.map((issue) => issue.reporter)).toEqual(["vera"])
  })

  test("a public client sends its ID in the body and no secret", async () => {
    const fake = new FakeYouTrack()
    fake.hubClient = { clientID: "nitpick-public" }
    const h = server({ fake })

    await signedIn(h)

    const [exchange] = tokenRequests(h, "authorization_code")
    expect(
      new URLSearchParams(exchange!.body.toString()).get("client_id")
    ).toBe("nitpick-public")
  })

  test("signing in again in the same browser ends the sign-in it held", async () => {
    const h = server()
    const first = await signedIn(h)
    const { location, cookie } = await start(h)

    const response = await back(
      h,
      h.fake.authorize(location, "vera"),
      `${cookie}; ${first}`
    )

    expect(cookiesOf(response).get(signInCookieName)).not.toBe(first)
    expect((await get(h, "/api/me", first)).status).toBe(401)
  })

  test.each([
    ["without the cookie the button set", (cookie: string) => [cookie, ""]],
    [
      "with another sign-in's state",
      (cookie: string) => [
        cookie,
        `${hubSignInCookieName}=${"A".repeat(43)}.${"B".repeat(43)}`,
      ],
    ],
    [
      "with a malformed cookie",
      (cookie: string) => [cookie, `${hubSignInCookieName}=x`],
    ],
  ])(
    "a code coming back %s signs no one in, and spends no code",
    async (_, browser) => {
      const h = server()
      const { location, cookie } = await start(h)
      const [, held] = browser(cookie)

      const response = await back(h, h.fake.authorize(location, "vera"), held!)

      expect(response.headers.get("location")).toBe("/?sign-in=expired")
      expect(cookiesOf(response).has(signInCookieName)).toBe(false)
      expect(tokenRequests(h, "authorization_code")).toEqual([])
    }
  )

  test("a code used twice signs in once", async () => {
    const h = server()
    const { location, cookie } = await start(h)
    const returned = h.fake.authorize(location, "vera")
    await back(h, returned, cookie)

    const again = await back(h, returned, cookie)

    expect(again.headers.get("location")).toBe("/?sign-in=failed")
    expect(cookiesOf(again).has(signInCookieName)).toBe(false)
  })

  test("a Reviewer who declines nitpick's access is told so", async () => {
    const h = server()
    const { location, cookie } = await start(h)

    const response = await back(
      h,
      h.fake.authorize(location, undefined),
      cookie
    )

    expect(response.headers.get("location")).toBe("/?sign-in=denied")
    expect(cookiesOf(response).has(signInCookieName)).toBe(false)
  })

  test("Hub refusing nitpick's registration, e.g. a changed secret, fails with a log line that names no secret, code or token", async () => {
    const lines: string[] = []
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "))
    })
    const h = server()
    h.fake.hubClient = { ...h.fake.hubClient, clientSecret: "rotated" }
    const { location, cookie } = await start(h)
    const returned = h.fake.authorize(location, "vera")

    const response = await back(h, returned, cookie)

    expect(response.headers.get("location")).toBe("/?sign-in=failed")
    expect(lines).toEqual([
      "Signing in through YouTrack failed: YouTrack's Hub answered 401 (invalid_client) to a token request.",
    ])
    const code = new URL(returned).searchParams.get("code")!
    expect(lines.join()).not.toContain(code)
    expect(lines.join()).not.toContain("fictional-hub-secret")
  })
})

describe("a sign-in through Hub over time", () => {
  test("renews its access token with the refresh token as it expires, once for requests at once, and files with the renewed one after a restart", async () => {
    const data = temporaryDirectory()
    const fake = new FakeYouTrack()
    const clock = { now: Date.UTC(2026, 9, 28, 9) }
    const h = server({ data, fake, clock })
    await stage(h, "vera", ["Button color is off"])
    const cookie = await signedIn(h)

    clock.now += 59 * 60 * 1000
    fake.expireAccessTokens()
    const projects = await Promise.all([
      get(h, "/api/projects", cookie),
      get(h, "/api/projects", cookie),
    ])

    expect(projects.map((response) => response.status)).toEqual([200, 200])
    expect(tokenRequests(h, "refresh_token")).toHaveLength(1)

    // Hub revoked the refresh token it replaced: only the renewed one, read
    // back from the sign-in's file, renews again.
    const restarted = server({ data, fake, clock })
    await restarted.signIns.load()
    clock.now += 2 * hour
    fake.expireAccessTokens()

    expect(await fileAll(restarted, "vera", cookie)).toMatchObject({
      status: "filed",
    })
    expect(tokenRequests(restarted, "refresh_token")).toHaveLength(2)
    expect(fake.issues.map((issue) => issue.reporter)).toEqual(["vera"])
  })

  test("a refresh token Hub no longer takes ends the sign-in with a clear message; the open session stays", async () => {
    const h = server()
    await stage(h, "vera", ["Button color is off"])
    const cookie = await signedIn(h)
    h.fake.refreshTokens.clear()
    h.clock.now += 2 * hour
    h.fake.expireAccessTokens()

    const projects = await get(h, "/api/projects", cookie)

    expect(projects.status).toBe(401)
    expect(await projects.json()).toEqual({
      error: endedHubSignInMessage,
      code: "signIn",
    })
    expect(readdirSync(join(h.data, "sign-ins"))).toEqual([])
    const again = await signedIn(h)
    const review = (await (
      await get(h, "/api/review", again)
    ).json()) as ReviewStateResponse
    expect(review.session?.tray.map((item) => item.finding.summary)).toEqual([
      "Button color is off",
    ])
  })

  test("Hub out of reach for a renewal keeps the sign-in, for the next request", async () => {
    const h = server()
    const cookie = await signedIn(h)
    h.clock.now += 2 * hour
    h.fake.expireAccessTokens()
    h.fake.intercept = (request) =>
      request.path === "hub/api/rest/oauth2/token" ? { status: 503 } : undefined

    const unreachable = await get(h, "/api/projects", cookie)
    h.fake.intercept = () => undefined
    const reachable = await get(h, "/api/projects", cookie)

    expect([unreachable.status, reachable.status]).toEqual([502, 200])
  })

  test("its tokens are sealed at rest and never reach the browser", async () => {
    const h = server()
    const answers: string[] = []
    const { location, cookie } = await start(h)
    const signedInResponse = await back(
      h,
      h.fake.authorize(location, "vera"),
      cookie
    )
    answers.push(JSON.stringify([...signedInResponse.headers]))
    const signIn = cookiesOf(signedInResponse).get(signInCookieName)!
    h.clock.now += 2 * hour
    h.fake.expireAccessTokens()
    for (const path of ["/api/me", "/api/projects", "/api/review"]) {
      const response = await get(h, path, signIn)
      answers.push(JSON.stringify([...response.headers]), await response.text())
    }

    const files = readdirSync(join(h.data, "sign-ins")).map((name) =>
      readFileSync(join(h.data, "sign-ins", name), "utf8")
    )
    const everything = [
      ...answers,
      ...files,
      inspect(h.signIns, { depth: Infinity, showHidden: true }),
    ].join("\n")
    expect(tokenRequests(h, "refresh_token")).toHaveLength(1)
    expect(everything).not.toMatch(/hub-(access|refresh|code)-\d/)
    expect(files[0]).toContain('"throughHub":true')
  })
})
