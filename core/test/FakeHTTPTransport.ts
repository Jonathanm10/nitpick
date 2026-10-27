// Ports Tests/NitpickCoreTests/Support/FakeHTTPTransport.swift: a scripted
// stand-in for the HTTP seam. Responses are consumed in FIFO order, and every
// sent request is recorded for exact-shape assertions.
import type { HTTPRequest, HTTPResponse, HTTPTransport } from "../src/http.ts"

export class NoStubbedResponse extends Error {
  constructor(url: string) {
    super(`No stubbed response for ${url}`)
    this.name = "NoStubbedResponse"
  }
}

type Stub = { readonly response: HTTPResponse } | { readonly error: unknown }

export class FakeHTTPTransport implements HTTPTransport {
  readonly sentRequests: HTTPRequest[] = []
  readonly #stubs: Stub[] = []
  readonly #events: string[] | undefined

  /** `events`, when given, gets one line per request, in send order. */
  constructor(events?: string[]) {
    this.#events = events
  }

  enqueue(json: string, status = 200): void {
    this.#stubs.push({
      response: { status, body: new TextEncoder().encode(json) },
    })
  }

  enqueueError(error: unknown): void {
    this.#stubs.push({ error })
  }

  get urls(): string[] {
    return this.sentRequests.map((request) => request.url)
  }

  async send(request: HTTPRequest): Promise<HTTPResponse> {
    this.sentRequests.push(request)
    this.#events?.push(`${request.method} ${request.url}`)
    const stub = this.#stubs.shift()
    if (stub === undefined) throw new NoStubbedResponse(request.url)
    if ("error" in stub) throw stub.error
    return stub.response
  }
}

/** A request's body as text, or undefined when it has none. */
export function bodyText(request: HTTPRequest | undefined): string | undefined {
  return request?.body === undefined
    ? undefined
    : new TextDecoder().decode(request.body)
}
