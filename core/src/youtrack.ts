// The YouTrack connection, ported from Sources/NitpickCore/YouTrack.swift:
// cleaning up the instance URL, verifying a token by fetching the current
// user and the projects, and the one authorized round trip every call makes,
// with today's error texts. Where a Reviewer's token is kept is the server's
// (its sign-ins); core only holds it for the calls it makes.
import { decodeUTF8 } from "./bytes.ts"
import type { HTTPTransport } from "./http.ts"
import { trimWhitespaceAndNewlines } from "./text.ts"
import {
  optionalString,
  payloadArray,
  payloadObject,
  requiredString,
} from "./youTrackPayload.ts"

// WHATWG URL is a global in Node and in browsers alike; ES2023's lib just
// doesn't declare it.
declare const URL: new (input: string) => {
  readonly username: string
  readonly password: string
  readonly host: string
  readonly hostname: string
  readonly pathname: string
}

/** The YouTrack project every Finding of a Review Session files into. */
export interface YouTrackProject {
  /** YouTrack's entity id, e.g. "0-12": what the issues API references. */
  readonly id: string
  /** The key issue IDs derive from, e.g. "RM" in RM-421. */
  readonly shortName: string
  readonly name: string
}

/** The Issue a filed Finding became, referenced only by its ID and URL. */
export interface FiledIssue {
  /** The human-readable issue ID, e.g. "RM-421". */
  readonly idReadable: string
  /** The issue's page on the instance. */
  readonly url: string
}

/** The Reviewer's YouTrack identity: who filed Issues are authored by. */
export interface YouTrackUser {
  readonly login: string
  readonly fullName: string
}

/** A verified connection: who files, and where they can file. */
export interface YouTrackConnection {
  readonly user: YouTrackUser
  /** Projects visible to the Reviewer, sorted by name. */
  readonly projects: ReadonlyArray<YouTrackProject>
}

/** A YouTrack failure the designer can act on: Swift's YouTrackError cases. */
export type YouTrackFailure =
  /** The entered instance URL can't be parsed into an http(s) URL. */
  | { readonly kind: "invalidInstanceURL"; readonly entered: string }
  /** An http:// URL beyond loopback would send the token in cleartext. */
  | { readonly kind: "insecureInstanceURL"; readonly entered: string }
  /** 401, or a 403 outside filing: the token is wrong, revoked or expired. */
  | { readonly kind: "tokenRejected" }
  /** The server answered, but not with the JSON YouTrack sends. */
  | { readonly kind: "notAYouTrackInstance"; readonly url: string }
  /** Any other non-success status. */
  | { readonly kind: "unexpectedResponse"; readonly statusCode: number }
  /** Filing was attempted with no YouTrack connection configured. */
  | { readonly kind: "notConnected" }
  /** A Finding can't file without a summary. */
  | { readonly kind: "summaryRequired" }
  | { readonly kind: "feedbackTitleRequired" }
  /** A 403 on a filing step: the token works, the permission is missing. */
  | { readonly kind: "permissionDenied"; readonly action: string }
  /** A 404 on a project lookup: gone, renamed, or not visible. */
  | { readonly kind: "projectNotFound"; readonly shortName: string }

export class YouTrackError extends Error {
  readonly failure: YouTrackFailure

  constructor(failure: YouTrackFailure) {
    super(message(failure))
    this.name = "YouTrackError"
    this.failure = failure
  }
}

function message(failure: YouTrackFailure): string {
  switch (failure.kind) {
    case "invalidInstanceURL":
      return `“${failure.entered}” is not a valid instance URL. Expected something like https://youtrack.example.com.`
    case "insecureInstanceURL":
      return `“${failure.entered}” is not secure: the permanent token would travel unencrypted. Use https://.`
    case "tokenRejected":
      return "YouTrack rejected the token. Check that the permanent token was pasted completely and is still valid."
    case "notAYouTrackInstance":
      return `${failure.url} did not answer like a YouTrack instance. Check the instance URL.`
    case "unexpectedResponse":
      return `YouTrack answered with HTTP ${failure.statusCode}. Check the instance URL, or try again later.`
    case "notConnected":
      return "Connect to YouTrack (instance URL + permanent token) before filing."
    case "summaryRequired":
      return "The Finding needs a summary before it can be filed."
    case "feedbackTitleRequired":
      return "The Feedback needs a title before it can be sent."
    case "permissionDenied":
      return `YouTrack denied permission to ${failure.action}. Ask a YouTrack administrator about your access.`
    case "projectNotFound":
      return `YouTrack has no ${failure.shortName} project visible to your account. Ask a YouTrack administrator about your access.`
  }
}

/**
 * An instance URL and the permanent token that authenticates against it. The
 * token sits in a private field, so logging the credentials, or anything that
 * holds them, never prints it.
 */
export class YouTrackCredentials {
  readonly instanceURL: string
  readonly #token: string

  /**
   * Cleans up what was entered: whitespace trimmed, https assumed, query,
   * fragment and trailing slashes dropped. Throws invalidInstanceURL or
   * insecureInstanceURL before anything reaches the network.
   */
  constructor(instanceURL: string, token: string) {
    this.instanceURL = normalizedInstanceURL(instanceURL)
    this.#token = trimWhitespaceAndNewlines(token)
  }

  /** The `Authorization` header's value. */
  authorization(): string {
    return `Bearer ${this.#token}`
  }
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"])

/**
 * The instance URL as the credentials keep it, or invalidInstanceURL or
 * insecureInstanceURL: the server checks its configured instance with it.
 */
export function normalizedInstanceURL(entered: string): string {
  const invalid = () =>
    new YouTrackError({ kind: "invalidInstanceURL", entered })
  const trimmed = trimWhitespaceAndNewlines(entered)
  if (trimmed === "") throw invalid()
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`
  // Swift's URLComponents keeps a scheme's case, so "HTTPS://" was refused.
  const scheme = withScheme.slice(0, withScheme.indexOf("://"))
  if (scheme !== "https" && scheme !== "http") throw invalid()
  let url: InstanceType<typeof URL>
  try {
    url = new URL(withScheme)
  } catch {
    throw invalid()
  }
  if (url.hostname === "") throw invalid()
  // The token rides in every request header; cleartext http is only
  // tolerable when it never leaves the machine. Like Swift, this compares
  // the bracketed IPv6 host, so "::1" never matches.
  if (scheme === "http" && !loopbackHosts.has(url.hostname)) {
    throw new YouTrackError({ kind: "insecureInstanceURL", entered })
  }
  const password = url.password === "" ? "" : `:${url.password}`
  const userInfo = url.username === "" ? "" : `${url.username}${password}@`
  return `${scheme}://${userInfo}${url.host}${withoutTrailingSlashes(url.pathname)}`
}

// A loop, not /\/+$/: an end-anchored regex backtracks quadratically over a
// long inner run of slashes.
function withoutTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === "/") end--
  return path.slice(0, end)
}

export interface RequestBody {
  readonly contentType: string
  readonly data: Uint8Array
}

export interface YouTrackCall<Payload> {
  readonly method?: "GET" | "POST"
  readonly path: string
  readonly query: string
  readonly body?: RequestBody
  /**
   * The step a 403 names: during filing a 403 means a missing permission,
   * not a bad token.
   */
  readonly deniedAction?: string
  /** Reads the response's JSON; any throw means it isn't YouTrack's. */
  readonly decode: (json: unknown) => Payload
}

/**
 * The transport and the credentials every call to one instance needs. The
 * transport is private: one that keeps its requests holds their headers, so
 * logging the client must not reach it.
 */
export class YouTrackClient {
  readonly #transport: HTTPTransport
  readonly credentials: YouTrackCredentials

  constructor(transport: HTTPTransport, credentials: YouTrackCredentials) {
    this.#transport = transport
    this.credentials = credentials
  }

  /**
   * One authorized round trip: builds the request, maps the status to an
   * error the designer can act on, and decodes the payload. A transport
   * failure propagates as it is.
   */
  async request<Payload>(call: YouTrackCall<Payload>): Promise<Payload> {
    const headers: Record<string, string> = {
      Authorization: this.credentials.authorization(),
      Accept: "application/json",
    }
    if (call.body !== undefined) headers["Content-Type"] = call.body.contentType
    // The base URL is normalized, and paths are constants plus entity IDs the
    // server issued. Composing by string keeps `,` and `$` literal.
    const url = `${this.credentials.instanceURL}/${call.path}?${call.query}`
    const response = await this.#transport.send(
      call.body === undefined
        ? { method: call.method ?? "GET", url, headers }
        : { method: call.method ?? "GET", url, headers, body: call.body.data }
    )
    if (response.status === 401) {
      throw new YouTrackError({ kind: "tokenRejected" })
    }
    if (response.status === 403) {
      throw new YouTrackError(
        call.deniedAction === undefined
          ? { kind: "tokenRejected" }
          : { kind: "permissionDenied", action: call.deniedAction }
      )
    }
    if (response.status < 200 || response.status >= 300) {
      throw new YouTrackError({
        kind: "unexpectedResponse",
        statusCode: response.status,
      })
    }
    try {
      return call.decode(JSON.parse(decodeUTF8(response.body)))
    } catch {
      throw new YouTrackError({
        kind: "notAYouTrackInstance",
        url: this.credentials.instanceURL,
      })
    }
  }
}

/**
 * YouTrack collection endpoints return one default-sized page (42) unless
 * `$top` is explicit, so projects are fetched page by page.
 */
const projectPageSize = 100
/** A server that never sends a short page must not loop forever. */
const projectCountLimit = 10_000

const byName = new Intl.Collator(undefined, { sensitivity: "accent" })

/**
 * Verifies the credentials by fetching the user Issues will be authored by
 * and the projects they can file into.
 */
export async function verifyYouTrack(
  youTrack: YouTrackClient
): Promise<YouTrackConnection> {
  const user = await youTrackUser(youTrack)
  const projects: YouTrackProject[] = []
  for (;;) {
    const page = await youTrack.request({
      path: "api/admin/projects",
      query: `fields=id,name,shortName&$top=${projectPageSize}&$skip=${projects.length}`,
      decode: (json) => payloadArray(json).map(project),
    })
    projects.push(...page)
    if (page.length < projectPageSize || projects.length >= projectCountLimit) {
      break
    }
  }
  return {
    user,
    projects: projects.sort((a, b) => byName.compare(a.name, b.name)),
  }
}

/** The user the credentials' token belongs to: who Issues are filed as. */
export function youTrackUser(youTrack: YouTrackClient): Promise<YouTrackUser> {
  return youTrack.request({
    path: "api/users/me",
    query: "fields=login,fullName",
    decode: (json) => {
      const me = payloadObject(json)
      const login = requiredString(me, "login")
      // Nullable on the server; display falls back to the login.
      return { login, fullName: optionalString(me, "fullName") ?? login }
    },
  })
}

function project(json: unknown): YouTrackProject {
  const payload = payloadObject(json)
  return {
    id: requiredString(payload, "id"),
    shortName: requiredString(payload, "shortName"),
    name: requiredString(payload, "name"),
  }
}

/** An Issue's page on the instance. */
export function issueURL(instanceURL: string, idReadable: string): string {
  return `${instanceURL}/issue/${idReadable}`
}
