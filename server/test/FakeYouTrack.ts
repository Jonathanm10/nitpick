// An in-memory YouTrack that answers the routes nitpick calls by route,
// rather than in a scripted order, and records every request and what it
// changed. The filing and Feedback tests, the crash-and-resume test and the
// live proof file against it; nothing here reaches a real instance. All
// data is fictional.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { HTTPRequest, HTTPResponse, HTTPTransport } from "@nitpick/core"

export interface FakeIssue {
  readonly id: string
  readonly idReadable: string
  readonly projectID: string
  readonly summary: string
  readonly description: string
  readonly customFields: unknown
  readonly attachments: { readonly fileName: string; readonly data: Buffer }[]
  readonly tags: string[]
  /** The login of the token's user, as YouTrack makes it the reporter. */
  readonly reporter: string
}

export interface RecordedRequest {
  readonly method: string
  /** After the instance's base path, e.g. "api/issues/2-1/tags". */
  readonly path: string
  readonly query: string
  readonly body: Buffer
  /** False while the fake holds it, and for good when the server died. */
  answered: boolean
}

/**
 * What `intercept` decides: answer with a failure, or hold the request
 * until the promise settles, standing in for a slow or vanished instance.
 */
export type Interception =
  | { readonly status: number; readonly body?: string }
  | Promise<void>
  | undefined

const json = (value: unknown, status = 200): HTTPResponse => ({
  status,
  body: new TextEncoder().encode(JSON.stringify(value)),
})

export class FakeYouTrack {
  readonly requests: RecordedRequest[] = []
  readonly issues: FakeIssue[] = []
  readonly tags: { readonly id: string; readonly name: string }[] = [
    { id: "6-1", name: "design-review" },
  ]
  /** Who each token belongs to. */
  users: Record<string, { login: string; fullName: string }> = {
    "perm:vera": { login: "vera", fullName: "Vera Baumann" },
    "perm:noor": { login: "noor", fullName: "Noor Haddad" },
  }
  projects = [
    { id: "0-12", shortName: "RM", name: "ReviewMe" },
    { id: "0-31", shortName: "WX", name: "Weatherly" },
    { id: "0-99", shortName: "NIT", name: "nitpick" },
  ]
  priorities = ["Show-stopper", "Critical", "Major", "Normal", "Minor"]
  /** A create carrying Priority or Assignee answers 400, as a changed schema does. */
  rejectsCustomFields = false
  /** Runs before each request is answered. */
  intercept: (request: RecordedRequest) => Interception = () => undefined
  #nextIssue = 101

  /** What the credentials name; requests are read below it. */
  instanceURL: string

  constructor(instanceURL = "https://youtrack.example.com/yt") {
    this.instanceURL = instanceURL
  }

  readonly transport: HTTPTransport = {
    send: (request) => this.#send(request),
  }

  /** Answered requests to `method path`, the ones that changed something. */
  answered(method: string, pattern: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        request.answered &&
        request.method === method &&
        pattern.test(request.path)
    )
  }

  /**
   * Serves the fake over loopback HTTP for a real server process, at
   * `http://127.0.0.1:<port>/yt`, which becomes the instance URL. Any free
   * port unless one is named.
   */
  async listen(
    port = 0
  ): Promise<{ readonly url: string; close(): Promise<void> }> {
    const server: Server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on("end", () => {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers[name] = value
        }
        void this.#send({
          method: incoming.method === "POST" ? "POST" : "GET",
          url: `${this.instanceURL}${incoming.url?.replace(/^\/yt/, "") ?? ""}`,
          headers: {
            Authorization: headers.authorization ?? "",
            "Content-Type": headers["content-type"] ?? "",
          },
          body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
        }).then(
          (response) => {
            outgoing.writeHead(response.status, {
              "Content-Type": "application/json",
            })
            outgoing.end(Buffer.from(response.body))
          },
          () => outgoing.destroy()
        )
      })
    })
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve)
    )
    const address = server.address() as AddressInfo
    this.instanceURL = `http://127.0.0.1:${address.port}/yt`
    return {
      url: this.instanceURL,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    }
  }

  async #send(request: HTTPRequest): Promise<HTTPResponse> {
    const url = new URL(request.url)
    const base = new URL(this.instanceURL).pathname.replace(/\/$/, "")
    const recorded: RecordedRequest = {
      method: request.method,
      path: url.pathname.slice(base.length + 1),
      query: decodeURIComponent(url.search.slice(1)),
      body: Buffer.from(request.body ?? new Uint8Array()),
      answered: false,
    }
    this.requests.push(recorded)
    const interception = this.intercept(recorded)
    if (interception instanceof Promise) await interception
    const response =
      interception !== undefined && !(interception instanceof Promise)
        ? {
            status: interception.status,
            body: new TextEncoder().encode(interception.body ?? "{}"),
          }
        : this.#answer(recorded, request.headers.Authorization ?? "")
    recorded.answered = response.status < 300
    return response
  }

  #answer(request: RecordedRequest, authorization: string): HTTPResponse {
    const user = this.users[authorization.replace(/^Bearer /, "")]
    if (user === undefined) return json({ error: "Unauthorized" }, 401)
    const { method, path } = request
    const body = <Body>() => JSON.parse(request.body.toString("utf8")) as Body
    let match: RegExpExecArray | null
    if (method === "GET" && path === "api/users/me") {
      return json({ ...user, $type: "Me" })
    }
    if (method === "GET" && path === "api/admin/projects") {
      return json(request.query.includes("$skip=0") ? this.projects : [])
    }
    if (
      method === "GET" &&
      (match = /^api\/admin\/projects\/([^/]+)\/customFields$/.exec(path))
    ) {
      return json([
        {
          field: { name: "Priority" },
          bundle: { values: this.priorities.map((name) => ({ name })) },
        },
        {
          field: { name: "Assignee" },
          bundle: { aggregatedUsers: Object.values(this.users) },
        },
      ])
    }
    if (
      method === "GET" &&
      (match = /^api\/admin\/projects\/(\w+)$/.exec(path))
    ) {
      const project = this.projects.find(
        (candidate) => candidate.shortName === match![1]
      )
      return project === undefined
        ? json({ error: "Not Found" }, 404)
        : json({ id: project.id, name: project.name })
    }
    if (method === "GET" && path === "api/tags") {
      const name = /query=([^&]*)/.exec(request.query)?.[1] ?? ""
      return json(this.tags.filter((tag) => tag.name.includes(name)))
    }
    if (method === "POST" && path === "api/tags") {
      const tag = {
        id: `6-${this.tags.length + 1}`,
        name: body<{ name: string }>().name,
      }
      this.tags.push(tag)
      return json(tag)
    }
    if (method === "POST" && path === "api/issues") {
      const created = body<{
        project: { id: string }
        summary: string
        description: string
        customFields?: unknown
      }>()
      if (this.rejectsCustomFields && created.customFields !== undefined) {
        return json({ error: "Unknown custom field" }, 400)
      }
      const project = this.projects.find((p) => p.id === created.project.id)
      if (project === undefined) return json({ error: "Not Found" }, 404)
      const number = this.#nextIssue++
      const issue: FakeIssue = {
        id: `2-${number}`,
        idReadable: `${project.shortName}-${number}`,
        projectID: project.id,
        summary: created.summary,
        description: created.description,
        customFields: created.customFields,
        attachments: [],
        tags: [],
        reporter: user.login,
      }
      this.issues.push(issue)
      return json({ id: issue.id, idReadable: issue.idReadable })
    }
    if (
      method === "POST" &&
      (match = /^api\/issues\/([^/]+)\/attachments$/.exec(path))
    ) {
      const issue = this.issues.find((candidate) => candidate.id === match![1])
      if (issue === undefined) return json({ error: "Not Found" }, 404)
      const parts = multipartParts(request.body)
      issue.attachments.push(...parts)
      return json(
        parts.map((part, index) => ({ id: `9-${index}`, name: part.fileName }))
      )
    }
    if (
      method === "POST" &&
      (match = /^api\/issues\/([^/]+)\/tags$/.exec(path))
    ) {
      const issue = this.issues.find((candidate) => candidate.id === match![1])
      const tag = this.tags.find(
        (candidate) => candidate.id === body<{ id: string }>().id
      )
      if (issue === undefined || tag === undefined) {
        return json({ error: "Not Found" }, 404)
      }
      issue.tags.push(tag.name)
      return json(tag)
    }
    return json({ error: `No fake for ${method} ${path}` }, 404)
  }
}

/** The `upload` parts of a multipart body, with their file names. */
function multipartParts(
  body: Buffer
): { readonly fileName: string; readonly data: Buffer }[] {
  const boundary = /^--([^\r\n]+)\r\n/.exec(body.toString("latin1"))?.[1]
  if (boundary === undefined) return []
  const delimiter = Buffer.from(`--${boundary}`)
  const parts: { fileName: string; data: Buffer }[] = []
  let start = body.indexOf(delimiter) + delimiter.length
  for (;;) {
    const end = body.indexOf(delimiter, start)
    if (end === -1) break
    const part = body.subarray(start + 2, end - 2) // CRLFs around the part
    const headerEnd = part.indexOf("\r\n\r\n")
    const headers = part.subarray(0, headerEnd).toString("utf8")
    parts.push({
      fileName: /filename="((?:[^"\\]|\\.)*)"/.exec(headers)?.[1] ?? "",
      data: Buffer.from(part.subarray(headerEnd + 4)),
    })
    start = end + delimiter.length
  }
  return parts
}
