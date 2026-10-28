// Signing in with YouTrack's own login instead of a permanent token: OAuth
// 2.0's authorization code flow with PKCE, against the Hub service built into
// YouTrack at `<instance>/hub`, as JetBrains documents it
// (https://www.jetbrains.com/help/hub/authorization-code.html). nitpick is a
// service registered in that Hub. Hub's access tokens last about an hour; the
// refresh token `access_type=offline` brings renews them, so a sign-in lasts
// as long as a token sign-in and filing still resumes after a restart.
import { createHash, randomBytes } from "node:crypto"
import {
  YouTrackError,
  type HTTPResponse,
  type HTTPTransport,
} from "@nitpick/core"

/** What a token request brings. Hub may leave out a new refresh token. */
export interface HubTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  /** Milliseconds since 1970. */
  readonly expiresAt: number
}

/** nitpick as a service registered in YouTrack's Hub. */
export interface HubClient {
  readonly clientID: string
  /** Left out for a public client, which PKCE alone protects. */
  readonly clientSecret?: string
}

/**
 * The symbolic name of the YouTrack service in YouTrack's built-in Hub:
 * the scope its REST API takes tokens for.
 */
const youTrackScope = "YouTrack"

export class YouTrackHub {
  readonly #hubURL: string
  readonly #client: HubClient
  readonly #transport: HTTPTransport
  readonly #now: () => number

  constructor(options: {
    /** The YouTrack instance, normalized; its Hub is at `/hub`. */
    readonly instanceURL: string
    readonly client: HubClient
    readonly transport: HTTPTransport
    readonly now?: () => number
  }) {
    this.#hubURL = `${options.instanceURL}/hub`
    this.#client = options.client
    this.#transport = options.transport
    this.#now = options.now ?? Date.now
  }

  /**
   * Where the browser signs in: YouTrack's login, unless the Reviewer is
   * already signed in there, then back to `redirectURI` with a code.
   */
  authorizationURL(redirectURI: string, state: string, verifier: string) {
    const query = new URLSearchParams({
      response_type: "code",
      client_id: this.#client.clientID,
      redirect_uri: redirectURI,
      scope: youTrackScope,
      state,
      request_credentials: "default",
      access_type: "offline",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })
    return `${this.#hubURL}/api/rest/oauth2/auth?${query}`
  }

  /** The tokens for the code Hub sent back to `redirectURI`. */
  exchange(
    code: string,
    redirectURI: string,
    verifier: string
  ): Promise<HubTokens> {
    return this.#token({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectURI,
      code_verifier: verifier,
    })
  }

  /** Fresh tokens; tokenRejected when Hub no longer takes the refresh token. */
  refresh(refreshToken: string): Promise<HubTokens> {
    return this.#token({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    })
  }

  async #token(parameters: Record<string, string>): Promise<HubTokens> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    }
    const { clientID, clientSecret } = this.#client
    const body = new URLSearchParams(parameters)
    if (clientSecret === undefined) {
      body.set("client_id", clientID)
    } else {
      headers.Authorization = `Basic ${Buffer.from(
        `${clientID}:${clientSecret}`
      ).toString("base64")}`
    }
    const response = await this.#transport.send({
      method: "POST",
      url: `${this.#hubURL}/api/rest/oauth2/token`,
      headers,
      body: new TextEncoder().encode(body.toString()),
    })
    return this.#tokens(response)
  }

  #tokens(response: HTTPResponse): HubTokens {
    let payload: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(response.body).toString("utf8")
      )
      if (typeof parsed === "object" && parsed !== null) {
        payload = parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON: the status decides below.
    }
    if (response.status === 400 && payload.error === "invalid_grant") {
      throw new YouTrackError({ kind: "tokenRejected" })
    }
    const { access_token, refresh_token, expires_in } = payload
    if (
      response.status !== 200 ||
      typeof access_token !== "string" ||
      typeof expires_in !== "number"
    ) {
      throw new HubRefused(response.status, payload.error)
    }
    return {
      accessToken: access_token,
      ...(typeof refresh_token === "string" && { refreshToken: refresh_token }),
      expiresAt: this.#now() + expires_in * 1000,
    }
  }
}

/**
 * A token request Hub turned down for another reason than a spent grant:
 * mostly nitpick's registration, e.g. a wrong secret or redirect URI. Its
 * message carries only Hub's error code, never a token.
 */
export class HubRefused extends Error {
  constructor(status: number, error: unknown) {
    super(
      `YouTrack's Hub answered ${status}${typeof error === "string" ? ` (${error.slice(0, 64)})` : ""} to a token request.`
    )
    this.name = "HubRefused"
  }
}

/** A random 256-bit value, base64url: a state or a PKCE code verifier. */
export function randomCode(): string {
  return randomBytes(32).toString("base64url")
}
