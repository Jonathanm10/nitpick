// The HTTP effects seam, ported from HTTPTransport in
// Sources/NitpickCore/Environment.swift. Every YouTrack call goes through
// it: the server sends for real, and tests script a fake.

export interface HTTPRequest {
  readonly method: "GET" | "POST"
  readonly url: string
  /** `Authorization` carries the token: never log a request's headers. */
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Uint8Array
}

export interface HTTPResponse {
  readonly status: number
  readonly body: Uint8Array
}

export interface HTTPTransport {
  /** Rejects only when no response arrived; any status resolves. */
  send(request: HTTPRequest): Promise<HTTPResponse>
}
