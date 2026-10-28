import { createHmac, timingSafeEqual } from "node:crypto"

/** The cookie a browser shows the device stream, set by `POST /api/stream-access`. */
export const streamAccessCookieName = "nitpick_stream_access"

/** A month, as the PRD's sign-in session lasts (issue 10 replaces this). */
const cookieMaxAgeSeconds = 30 * 24 * 60 * 60

/**
 * The shared access token the device stream accepts until sign-in exists
 * (issue 10). A client sends it as a Bearer token. A browser trades it once
 * for an HttpOnly cookie, because `<img>` and WebSocket requests can't carry
 * a header. The cookie holds an HMAC of the token rather than the token, and
 * the token sits in a private field, so logging never prints it.
 */
export class StreamAccess {
  readonly #token: string
  readonly #cookieValue: string

  constructor(token: string) {
    this.#token = token
    this.#cookieValue = createHmac("sha256", token)
      .update("nitpick device stream access")
      .digest("base64url")
  }

  /** Whether `token` is the host's. */
  accepts(token: string): boolean {
    return equalInConstantTime(token, this.#token)
  }

  /** Whether a request carries the token, as a Bearer header or the cookie. */
  admits(header: (name: string) => string | undefined): boolean {
    const bearer = /^Bearer\s+(.+)$/i.exec(header("authorization") ?? "")
    if (bearer !== null) return this.accepts(bearer[1]!.trim())
    const cookie = cookieValue(header("cookie"), streamAccessCookieName)
    return (
      cookie !== undefined && equalInConstantTime(cookie, this.#cookieValue)
    )
  }

  /**
   * The `Set-Cookie` value that admits this browser: sent to /api only, never
   * readable by the page's scripts, and never on a cross-site request.
   */
  cookie(secure: boolean): string {
    return [
      `${streamAccessCookieName}=${this.#cookieValue}`,
      "Path=/api",
      `Max-Age=${cookieMaxAgeSeconds}`,
      "HttpOnly",
      "SameSite=Strict",
      ...(secure ? ["Secure"] : []),
    ].join("; ")
  }
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

function equalInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
