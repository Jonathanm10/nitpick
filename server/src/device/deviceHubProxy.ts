// The only way to the device hub, after T3 Code's apps/server/src/device/DeviceHubProxy.ts
// (MIT). The hub listens on loopback only: serve-sim's shell-exec token can
// be read from its own API, so the proxy allowlists the routes the viewer
// needs, authenticates every request, and adds the hub's token itself.
import type { IncomingMessage } from "node:http"
import { STATUS_CODES } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import type { DeviceStream, HubEndpoint } from "./deviceHub.ts"
import { repeatStillFrame } from "./mjpegStillFrame.ts"

/** Where the proxy is mounted; the rest of the path is the hub's own. */
export const deviceHubRoutePrefix = "/api/device-hub"

const udid = "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}"

/** An Android emulator as adb names it, which serve-emu takes as `device`. */
const emulatorSerial = /^emulator-[0-9]{1,5}$/

/** A route the viewer needs, and exactly how it uses it. */
interface AllowedRoute {
  readonly path: RegExp
  readonly isUpgrade: boolean
  /** The one method the viewer sends; any other is a 405. */
  readonly method: "GET" | "POST"
  /**
   * The `device` query, the only one forwarded. Without a pattern it is
   * optional and passed as it came; with one it is required and checked.
   */
  readonly device?: RegExp
  /** Query the proxy sets itself, whatever the viewer sent. */
  readonly fixedQuery?: Readonly<Record<string, string>>
}

const allowedRoutes: ReadonlyArray<AllowedRoute> = [
  // iOS video: H.264 for WebCodecs, and MJPEG where it can't decode.
  {
    path: new RegExp(
      `^/vendor/serve-sim/helper/${udid}/stream\\.(avcc|mjpeg)$`
    ),
    isUpgrade: false,
    method: "GET",
  },
  // iOS touch and keyboard input.
  {
    path: /^\/vendor\/serve-sim\/helper\/ws$/,
    isUpgrade: true,
    method: "GET",
  },
  // Android video: serve-emu's WebRTC answer to the viewer's offer, and the
  // session's close, both POSTed JSON. WebRTC needs no secure context.
  {
    path: /^\/vendor\/serve-emu\/webrtc\/(offer|close)$/,
    isUpgrade: false,
    method: "POST",
    device: emulatorSerial,
  },
  // Android gestures and keys. Video goes over WebRTC, never this socket.
  {
    path: /^\/vendor\/serve-emu\/ws$/,
    isUpgrade: true,
    method: "GET",
    device: emulatorSerial,
    fixedQuery: { video: "0" },
  },
]

export interface HubRequest {
  readonly method: string
  /** The request's path and query, starting at the proxy's mount point. */
  readonly url: string
  readonly isUpgrade: boolean
  readonly header: (name: string) => string | undefined
}

/** A request's live sign-in, which the stream or socket it opens ends with. */
export interface Admission {
  /** Calls `end` once the sign-in ends; answers the function that stops it. */
  readonly onEnd: (end: () => void) => () => void
}

/** The live sign-in a request's headers carry, if any. */
export type Admit = (
  header: (name: string) => string | undefined
) => Admission | undefined

export type HubRoute =
  | { readonly status: 401 | 403 | 404 | 503 }
  | { readonly status: 405; readonly allow: string }
  | {
      readonly upstream: string
      readonly hub: HubEndpoint
      readonly admission: Admission
    }

/**
 * Where a request goes, checked in T3 Code's order: the allowlist first, so
 * any other route is a 404 with or without auth, then the method, then the
 * sign-in, then the origin of anything that isn't a plain read, then
 * whether the hub runs.
 */
export function routeHubRequest(
  request: HubRequest,
  admit: Admit,
  stream: DeviceStream | undefined
): HubRoute {
  let url: URL
  try {
    url = new URL(request.url, "http://nitpick.invalid")
  } catch {
    // A target no URL parses, which an upgrade's handler can't let throw.
    return { status: 404 }
  }
  const hubPath = url.pathname.slice(deviceHubRoutePrefix.length)
  const device = url.searchParams.get("device")
  const route = url.pathname.startsWith(`${deviceHubRoutePrefix}/`)
    ? allowedRoutes.find(
        (candidate) =>
          candidate.isUpgrade === request.isUpgrade &&
          candidate.path.test(hubPath) &&
          (candidate.device === undefined ||
            (device !== null && candidate.device.test(device)))
      )
    : undefined
  if (route === undefined) return { status: 404 }
  if (request.method !== route.method) {
    return { status: 405, allow: route.method }
  }
  const admission = admit(request.header)
  if (admission === undefined) return { status: 401 }
  // WebSockets skip CORS, and a POST may come from a form, so a page on
  // another origin of the same site, which the SameSite cookie doesn't
  // stop, mustn't open the input socket or a WebRTC session.
  if (
    (request.isUpgrade || request.method !== "GET") &&
    !isSameOrigin(request.header)
  ) {
    return { status: 403 }
  }
  const hub = stream?.endpoint()
  if (hub === undefined) return { status: 503 }
  const query = new URLSearchParams()
  if (device !== null) query.set("device", device)
  for (const [name, value] of Object.entries(route.fixedQuery ?? {})) {
    query.set(name, value)
  }
  const search = query.size > 0 ? `?${query.toString()}` : ""
  return { upstream: `${hub.origin}${hubPath}${search}`, hub, admission }
}

/** The `Origin` header, when the client sent one, names this server. */
export function isSameOrigin(header: HubRequest["header"]): boolean {
  const origin = header("origin")
  if (origin === undefined) return true
  try {
    return new URL(origin).host === header("host")
  } catch {
    return false
  }
}

/**
 * Forwards an allowlisted GET. Only the hub's content type comes back: no
 * cookie, and nothing that would let a cache or a compressor hold on to a
 * stream that never ends. An MJPEG stream re-sends its last frame once the
 * screen goes still. The stream ends when its viewer leaves, or when the
 * sign-in that opened it ends.
 */
export async function proxyHubHTTP(
  request: Request,
  route: Extract<HubRoute, { upstream: string }>
): Promise<Response> {
  const signedOut = new AbortController()
  const stopWatching = route.admission.onEnd(() => signedOut.abort())
  const signal = AbortSignal.any([request.signal, signedOut.signal])
  // WebRTC signaling is a small JSON body, read here to follow its session.
  let signaling: string | undefined
  if (request.method === "POST") {
    signaling = await textUpTo(request, signalingBodyLimit)
    if (signaling === undefined) {
      stopWatching()
      return refusal({ status: 413 })
    }
  }
  let upstream: Response
  try {
    const contentType = request.headers.get("content-type")
    upstream = await fetch(route.upstream, {
      method: request.method,
      headers: {
        authorization: `Bearer ${route.hub.token}`,
        ...(contentType !== null && { "content-type": contentType }),
      },
      ...(signaling !== undefined && { body: signaling }),
      signal,
    })
  } catch {
    stopWatching()
    return refusal({ status: 502 })
  }
  if (signaling !== undefined)
    followWebRTCSession(route, signaling, upstream.ok)
  // The hub refusing its own token means it restarted under the request.
  if (upstream.status === 401 || upstream.status === 403) {
    stopWatching()
    await upstream.body?.cancel()
    return refusal({ status: 503 })
  }
  const headers = new Headers({
    "Cache-Control": "no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
  })
  const contentType = upstream.headers.get("content-type")
  if (contentType !== null) headers.set("Content-Type", contentType)
  const body =
    upstream.body !== null &&
    contentType?.startsWith("multipart/x-mixed-replace")
      ? repeatStillFrame(upstream.body)
      : upstream.body
  if (body === null) stopWatching()
  return new Response(body && endingWithViewer(body, signal, stopWatching), {
    status: upstream.status,
    headers,
  })
}

/** serve-emu caps WebRTC signaling bodies at 256 KiB itself. */
const signalingBodyLimit = 256 * 1024

/**
 * The WebRTC sessions serve-emu answered, by session ID, each with what
 * stops following it. Their media flows straight from the hub, outside the
 * proxy, so each is closed on serve-emu when the sign-in that opened it
 * ends, as an HTTP stream is. The viewer's own close forgets it.
 */
const webRTCSessions = new Map<string, () => void>()

function followWebRTCSession(
  route: Extract<HubRoute, { upstream: string }>,
  signaling: string,
  answered: boolean
): void {
  let sessionId: unknown
  try {
    sessionId = (JSON.parse(signaling) as { sessionId?: unknown }).sessionId
  } catch {
    return
  }
  if (typeof sessionId !== "string") return
  const url = new URL(route.upstream)
  if (url.pathname.endsWith("/webrtc/close")) {
    webRTCSessions.get(sessionId)?.()
    return
  }
  if (!answered || webRTCSessions.has(sessionId)) return
  url.pathname = url.pathname.replace(/\/offer$/, "/close")
  const stop = route.admission.onEnd(() => {
    webRTCSessions.delete(sessionId)
    void fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${route.hub.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  })
  webRTCSessions.set(sessionId, () => {
    webRTCSessions.delete(sessionId)
    stop()
  })
}

/** The request's body as text, or undefined past `limit` bytes. */
async function textUpTo(
  request: Request,
  limit: number
): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength
    if (size > limit) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * A viewer leaving, or its sign-in ending, aborts the hub's response under
 * the stream; that ends the stream rather than failing it, so the server
 * logs no error for it.
 */
function endingWithViewer(
  body: ReadableStream<Uint8Array>,
  viewer: AbortSignal,
  ended: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            ended()
            controller.close()
          } else {
            controller.enqueue(value)
          }
        } catch (error) {
          ended()
          if (viewer.aborted) controller.close()
          else controller.error(error)
        }
      },
      cancel: (reason) => {
        ended()
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 }
  )
}

export function refusal(route: {
  readonly status: number
  readonly allow?: string
}): Response {
  return new Response(STATUS_CODES[route.status] ?? "Refused", {
    status: route.status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...(route.allow !== undefined && { Allow: route.allow }),
    },
  })
}

/**
 * The input socket: an upgrade the route allows opens the hub's socket with
 * the hub's token, and only then completes the browser's handshake, so the
 * browser never sees the hub's headers. Frames pass through unchanged, until
 * either side closes or the sign-in that opened it ends.
 */
export function hubUpgradeHandler(
  admit: Admit,
  stream: DeviceStream | undefined
): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const server = new WebSocketServer({ noServer: true })
  return (request, socket, head) => {
    const route = routeHubRequest(
      {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        isUpgrade: true,
        header: (name) => {
          const value = request.headers[name]
          return Array.isArray(value) ? value.join(", ") : value
        },
      },
      admit,
      stream
    )
    if ("status" in route) {
      refuseUpgrade(socket, route.status)
      return
    }
    const upstream = new WebSocket(route.upstream.replace(/^http/, "ws"), {
      headers: { authorization: `Bearer ${route.hub.token}` },
      perMessageDeflate: false,
    })
    let piped = false
    let browser: WebSocket | undefined
    const stopWatching = route.admission.onEnd(() => {
      upstream.terminate()
      if (browser === undefined) refuseUpgrade(socket, 401)
      else browser.terminate()
    })
    upstream.once("close", stopWatching)
    upstream.on("error", () => {
      if (!piped) refuseUpgrade(socket, 502)
      upstream.terminate()
    })
    upstream.once("unexpected-response", (_request, response) => {
      response.resume()
      upstream.terminate()
    })
    // A browser gone before the hub answered, or a handshake ws refused.
    socket.once("close", () => {
      stopWatching()
      if (!piped) upstream.terminate()
    })
    upstream.once("open", () => {
      server.handleUpgrade(request, socket, head, (client) => {
        piped = true
        browser = client
        pipeSockets(client, upstream)
      })
    })
  }
}

function pipeSockets(client: WebSocket, upstream: WebSocket): void {
  const forward = (to: WebSocket) => (data: RawData, isBinary: boolean) => {
    if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary })
  }
  client.on("message", forward(upstream))
  upstream.on("message", forward(client))
  const closeOther = (other: WebSocket) => (code: number, reason: Buffer) => {
    if (other.readyState === WebSocket.OPEN) {
      other.close(sendableCloseCode(code), reason)
    } else if (other.readyState === WebSocket.CONNECTING) {
      other.terminate()
    }
  }
  client.on("close", closeOther(upstream))
  upstream.on("close", closeOther(client))
  client.on("error", () => upstream.terminate())
  upstream.on("error", () => client.terminate())
}

/** The codes ws can send; 1005 and 1006 only describe a close. */
function sendableCloseCode(code: number): number {
  const sendable =
    (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
    (code >= 3000 && code <= 4999)
  return sendable ? code : 1011
}

function refuseUpgrade(socket: Duplex, status: number): void {
  if (!socket.writable) return
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Refused"}\r\n` +
      "Connection: close\r\nContent-Length: 0\r\n\r\n"
  )
}
