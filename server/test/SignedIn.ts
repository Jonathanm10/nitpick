// A test's way in, now that every API route asks for a sign-in: Reviewers
// over a data directory and a YouTrack transport, and an app whose requests
// carry a sign-in cookie. The sign-in goes straight into the store, so a
// scripted transport sees only the requests a test scripts. All users and
// tokens are fictional.
import { join } from "node:path"
import {
  YouTrackClient,
  YouTrackCredentials,
  type HTTPTransport,
  type YouTrackUser,
} from "@nitpick/core"
import { createApp } from "../src/app.ts"
import type { DeviceHost } from "../src/device/DeviceHost.ts"
import type { DeviceStream } from "../src/device/deviceHub.ts"
import { HistoryStore } from "../src/historyStore.ts"
import type { YouTrackAccount } from "../src/reviewer.ts"
import { Reviewers, signInCookieName } from "../src/reviewers.ts"
import { SignInStore } from "../src/signInStore.ts"
import type { SubprocessRunner } from "../src/subprocess.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

export const vera: YouTrackUser = { login: "vera", fullName: "Vera Baumann" }

/** For tests whose server never reaches YouTrack. */
const unreachableYouTrack: HTTPTransport = {
  send: () => Promise.reject(new Error("This test reaches no YouTrack.")),
}

export function signedInApp(options: {
  readonly data: string
  readonly deviceHost: DeviceHost
  readonly transport?: HTTPTransport
  readonly instanceURL?: string
  readonly runner?: SubprocessRunner
  readonly history?: HistoryStore
  /** Who is signed in; their token is `perm:<login>`. */
  readonly user?: YouTrackUser
  readonly deviceStream?: DeviceStream
  readonly serverVersion?: string
  readonly webRoot?: string
}) {
  const {
    data,
    deviceHost,
    transport = unreachableYouTrack,
    instanceURL = "https://youtrack.example.com",
    runner = new FakeSubprocessRunner(),
    user = vera,
  } = options
  const signIns = new SignInStore(data, instanceURL)
  const history = options.history ?? new HistoryStore(join(data, "history"))
  const reviewers = new Reviewers({
    directory: join(data, "reviewers"),
    instanceURL,
    transport,
    signIns,
    dependencies: { deviceHost, runner, history },
  })
  const server = createApp({
    deviceHost,
    reviewers,
    history,
    serverVersion: options.serverVersion ?? "0.0.0",
    webRoot: options.webRoot,
    deviceStream: options.deviceStream,
  })
  const token = `perm:${user.login}`
  // On the first request, so a test that sends none writes no sign-in.
  let signIn: Promise<string> | undefined
  const cookie = () =>
    (signIn ??= signIns
      .create(user, token)
      .then(({ id }) => `${signInCookieName}=${id}`))
  const account: YouTrackAccount = {
    user,
    youTrack: new YouTrackClient(
      transport,
      new YouTrackCredentials(instanceURL, token)
    ),
  }
  return {
    /** The app as the signed-in browser reaches it. */
    app: withCookie(server, cookie),
    /** The app itself, for a real server or a request without the cookie. */
    server,
    /** The `Cookie` header of the signed-in browser. */
    cookie,
    reviewers,
    signIns,
    history,
    reviewer: reviewers.reviewer(user.login),
    /** The signed-in Reviewer's directory. */
    directory: join(data, "reviewers", user.login),
    account,
  }
}

/** `app.request`, with the sign-in cookie on every request. */
export function withCookie(
  app: {
    request(path: string, init?: RequestInit): Response | Promise<Response>
  },
  cookie: () => Promise<string>
): { request(path: string, init?: RequestInit): Promise<Response> } {
  return {
    request: async (path, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set("cookie", await cookie())
      return app.request(path, { ...init, headers })
    },
  }
}
