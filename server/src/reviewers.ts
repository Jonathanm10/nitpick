// The signed-in Reviewers. A Reviewer signs in through YouTrack's own login
// when nitpick is registered with YouTrack's Hub (youTrackHub.ts), otherwise
// with their YouTrack permanent token; either way api/users/me names them,
// as Sources/NitpickCore/YouTrack.swift verified a token, and there are no
// other accounts (PRD answer 1). Each request
// acts for the Reviewer its sign-in cookie names, with that sign-in's token,
// on that Reviewer's own side of the server (PRD answer 5).
//
//   <data>/reviewers/<YouTrack login>/   each Reviewer's ReviewerStore
import { join } from "node:path"
import {
  trimWhitespaceAndNewlines,
  YouTrackClient,
  YouTrackCredentials,
  YouTrackError,
  youTrackUser,
  type HTTPTransport,
  type YouTrackUser,
} from "@nitpick/core"
import type { Admission } from "./device/deviceHubProxy.ts"
import {
  Reviewer,
  type ReviewerDependencies,
  type YouTrackAccount,
} from "./reviewer.ts"
import { signInLifetime, type SignIn, type SignInStore } from "./signInStore.ts"
import { randomCode, type HubTokens, type YouTrackHub } from "./youTrackHub.ts"

/** The cookie that carries a sign-in's ID. */
export const signInCookieName = "nitpick_sign_in"

/** What the page shows when YouTrack stops taking a sign-in's token. */
export const rejectedTokenMessage =
  "YouTrack rejected your token, so you were signed out. Sign in again with a valid permanent token; your open review is kept."

/** What it shows when YouTrack ends a sign-in through its login. */
export const endedHubSignInMessage =
  "YouTrack ended your sign-in, so you were signed out. Sign in again; your open review is kept."

/** Why a sign-in YouTrack stopped taking ended, as its page shows it. */
export function rejectedMessage(signIn: SignIn): string {
  return signIn.throughHub ? endedHubSignInMessage : rejectedTokenMessage
}

/** A sign-in through YouTrack's login, under way in one browser. */
export interface HubSignInStart {
  /** Hub's login page, where the browser goes next. */
  readonly url: string
  /** What the browser keeps for the way back: the state and PKCE verifier. */
  readonly state: string
  readonly verifier: string
}

/** A request's Reviewer: their sign-in, YouTrack account and server side. */
export interface SignedIn extends YouTrackAccount {
  readonly signIn: SignIn
  readonly reviewer: Reviewer
}

export type Authentication =
  | {
      readonly status: "signedIn"
      /** The cookie's ID, which only a renewed cookie needs again. */
      readonly id: string
      readonly signedIn: SignedIn
    }
  /** With the reason when the sign-in ended by itself, e.g. a rejected token. */
  | { readonly status: "signedOut"; readonly reason?: string }

/** A sign-in that didn't start, with the status and words the page shows. */
export class SignInFailed extends Error {
  readonly status: 400 | 401 | 502

  constructor(status: 400 | 401 | 502, message: string) {
    super(message)
    this.name = "SignInFailed"
    this.status = status
  }
}

export class Reviewers {
  readonly #directory: string
  readonly #instanceURL: string
  readonly #transport: HTTPTransport
  readonly #signIns: SignInStore
  readonly #hub: YouTrackHub | undefined
  readonly #dependencies: ReviewerDependencies
  readonly #reviewers = new Map<string, Reviewer>()

  constructor(options: {
    /** Where each Reviewer's own directory goes. */
    readonly directory: string
    readonly instanceURL: string
    readonly transport: HTTPTransport
    readonly signIns: SignInStore
    /** nitpick's registration with YouTrack's Hub, when there is one. */
    readonly hub?: YouTrackHub
    readonly dependencies: ReviewerDependencies
  }) {
    this.#directory = options.directory
    this.#instanceURL = options.instanceURL
    this.#transport = options.transport
    this.#signIns = options.signIns
    this.#hub = options.hub
    this.#dependencies = options.dependencies
  }

  /** Whether Reviewers sign in through YouTrack's login, needing no token. */
  get signInThroughHub(): boolean {
    return this.#hub !== undefined
  }

  /** Starts a sign-in through YouTrack's login; Hub returns to `redirectURI`. */
  startHubSignIn(redirectURI: string): HubSignInStart {
    if (this.#hub === undefined) throw new SignInFailed(400, noHubMessage)
    const state = randomCode()
    const verifier = randomCode()
    return {
      url: this.#hub.authorizationURL(redirectURI, state, verifier),
      state,
      verifier,
    }
  }

  /**
   * Finishes it with the code Hub sent back: Hub's tokens, then YouTrack's
   * user for them, as for a permanent token.
   */
  async finishHubSignIn(
    code: string,
    redirectURI: string,
    verifier: string
  ): Promise<{ readonly id: string; readonly signedIn: SignedIn }> {
    if (this.#hub === undefined) throw new SignInFailed(400, noHubMessage)
    const tokens = await this.#hub.exchange(code, redirectURI, verifier)
    return this.#started(tokens)
  }

  /**
   * Checks the token with YouTrack and starts a sign-in for its user. A
   * File all a restart cut short resumes once its Reviewer is back.
   */
  async signIn(
    token: string
  ): Promise<{ readonly id: string; readonly signedIn: SignedIn }> {
    if (trimWhitespaceAndNewlines(token) === "") {
      throw new SignInFailed(400, "Paste your YouTrack permanent token.")
    }
    return this.#started(token)
  }

  /** Asks YouTrack whose token it is, then starts their sign-in. */
  async #started(
    token: string | HubTokens
  ): Promise<{ readonly id: string; readonly signedIn: SignedIn }> {
    const credentials = new YouTrackCredentials(
      this.#instanceURL,
      typeof token === "string" ? token : token.accessToken
    )
    let user: YouTrackUser
    try {
      user = await youTrackUser(
        new YouTrackClient(this.#transport, credentials)
      )
    } catch (error) {
      if (!(error instanceof YouTrackError)) {
        throw new SignInFailed(
          502,
          "YouTrack couldn't be reached, so the token couldn't be checked. Try again later."
        )
      }
      throw new SignInFailed(
        error.failure.kind === "tokenRejected" ? 401 : 502,
        error.message
      )
    }
    const { id, signIn } = await this.#signIns.create(user, token)
    const signedIn = this.#signedIn(signIn)
    void this.#resume(signedIn)
    return { id, signedIn }
  }

  /** The Reviewer a request's `Cookie` header signs in, if any. */
  authenticate(cookieHeader: string | undefined): Authentication {
    const id = cookieValue(cookieHeader, signInCookieName)
    if (id === undefined) return { status: "signedOut" }
    const signIn = this.#signIns.find(id)
    if (signIn === undefined) {
      const reason = this.#signIns.endingOf(id)
      return reason === undefined
        ? { status: "signedOut" }
        : { status: "signedOut", reason }
    }
    // Any request keeps the Reviewer's device theirs.
    this.#dependencies.deviceClaims.seen(signIn.user.login)
    return { status: "signedIn", id, signedIn: this.#signedIn(signIn) }
  }

  /**
   * The live sign-in a request's headers carry, for the device hub proxy,
   * which ends the request's stream or socket when the sign-in ends.
   */
  admit(header: (name: string) => string | undefined): Admission | undefined {
    const authentication = this.authenticate(header("cookie"))
    if (authentication.status === "signedOut") return undefined
    const { signIn } = authentication.signedIn
    return { onEnd: (end) => this.#signIns.onEnd(signIn, end) }
  }

  /** The sliding expiry: whether the sign-in's end moved, for its cookie. */
  renew(signedIn: SignedIn): Promise<boolean> {
    return this.#signIns.renew(signedIn.signIn)
  }

  /** Sign out: the sign-in and its token go; the open session stays. */
  signOut(signedIn: SignedIn): Promise<void> {
    return this.#signIns.end(signedIn.signIn)
  }

  /** YouTrack stopped taking the sign-in's token: its page signs in again. */
  endRejected(signIn: SignIn): Promise<void> {
    return this.#signIns.end(signIn, rejectedMessage(signIn))
  }

  /**
   * Starts File all with the sign-in's token. A run already going throws
   * ShellBusy at once; the promise settles when the run ends.
   */
  fileAll(signedIn: SignedIn): Promise<void> {
    return this.#watch(signedIn.signIn, signedIn.reviewer.fileAll(signedIn))
  }

  /**
   * At startup: resumes each Reviewer's interrupted File all with their
   * latest sign-in. One without a sign-in resumes when they sign in.
   */
  async resumeInterruptedFilings(): Promise<number> {
    const logins = new Set<string>()
    let resumed = 0
    for (const signIn of this.#signIns.all()) {
      if (logins.has(signIn.user.login)) continue
      logins.add(signIn.user.login)
      if (await this.#resume(this.#signedIn(signIn))) resumed++
    }
    return resumed
  }

  /** The Reviewer with this YouTrack login, one for all their sign-ins. */
  reviewer(login: string): Reviewer {
    let reviewer = this.#reviewers.get(login)
    if (reviewer === undefined) {
      reviewer = new Reviewer(
        login,
        join(this.#directory, directoryName(login)),
        this.#dependencies
      )
      this.#reviewers.set(login, reviewer)
    }
    return reviewer
  }

  #signedIn(signIn: SignIn): SignedIn {
    return {
      signIn,
      user: signIn.user,
      youTrack: new YouTrackClient(this.#transport, signIn.credentials),
      reviewer: this.reviewer(signIn.user.login),
    }
  }

  async #resume(signedIn: SignedIn): Promise<boolean> {
    try {
      const resumed = await signedIn.reviewer.resumeInterruptedFiling(signedIn)
      if (resumed === undefined) return false
      void this.#watch(signedIn.signIn, resumed.run)
      return true
    } catch {
      // The mark stays, for the next start or sign-in.
      return false
    }
  }

  /** A run YouTrack refused the token of ends that sign-in. */
  async #watch(signIn: SignIn, run: Promise<unknown>): Promise<void> {
    const failure = await run
    if (
      failure instanceof YouTrackError &&
      failure.failure.kind === "tokenRejected"
    ) {
      await this.endRejected(signIn).catch(() => {})
    }
  }
}

const noHubMessage = "nitpick isn't registered with YouTrack's Hub."

/** The `Set-Cookie` value for a sign-in: for /api only, never for scripts. */
export function signInCookie(id: string, secure: boolean): string {
  return cookie(`${signInCookieName}=${id}`, signInLifetime / 1000, secure)
}

/** The `Set-Cookie` value that removes the sign-in cookie. */
export function signedOutCookie(secure: boolean): string {
  return cookie(`${signInCookieName}=`, 0, secure)
}

/** The cookie that keeps a Hub sign-in's state and verifier for the way back. */
export const hubSignInCookieName = "nitpick_hub_sign_in"

/** Where Hub sends the browser back; only that route reads the cookie. */
export const hubCallbackPath = "/api/sign-in/youtrack/callback"

/**
 * The `Set-Cookie` value for a Hub sign-in under way, which ten minutes
 * end; an empty `start` removes it.
 */
export function hubSignInCookie(
  start: Pick<HubSignInStart, "state" | "verifier"> | undefined,
  secure: boolean
): string {
  return cookie(
    `${hubSignInCookieName}=${start === undefined ? "" : `${start.state}.${start.verifier}`}`,
    start === undefined ? 0 : 10 * 60,
    secure,
    hubCallbackPath
  )
}

/** The state and verifier a request's `Cookie` header keeps, if any. */
export function hubSignInOf(
  cookieHeader: string | undefined
): Pick<HubSignInStart, "state" | "verifier"> | undefined {
  const [state, verifier, ...rest] = (
    cookieValue(cookieHeader, hubSignInCookieName) ?? ""
  ).split(".")
  return state && verifier && rest.length === 0
    ? { state, verifier }
    : undefined
}

function cookie(
  pair: string,
  maxAge: number,
  secure: boolean,
  path = "/api"
): string {
  return [
    pair,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ")
}

function cookieValue(
  header: string | undefined,
  name: string
): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=")
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim()
    }
  }
  return undefined
}

/** A login as one path segment: never "." or "..", never a separator. */
function directoryName(login: string): string {
  return encodeURIComponent(login).replaceAll(".", "%2E")
}
