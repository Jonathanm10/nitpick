// The only way to the device hub, after T3 Code's apps/server/src/device/DeviceHubProxy.ts
// (MIT). The hub listens on loopback only: serve-sim's shell-exec token can
// be read from its own API, so the proxy allowlists the routes the viewer
// needs, authenticates every request, and adds the hub's token itself.
import type { IncomingMessage } from "node:http"
import { STATUS_CODES } from "node:http"
import type { Duplex } from "node:stream"
import { WebSocket, WebSocketServer, type RawData } from "ws"
import type { StreamAccess } from "../streamAccess.ts"
import type { DeviceStream, HubEndpoint } from "./deviceHub.ts"
import { repeatStillFrame } from "./mjpegStillFrame.ts"

/** Where the proxy is mounted; the rest of the path is the hub's own. */
export const deviceHubRoutePrefix = "/api/device-hub"

const udid = "[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}"

/** The viewer's video: H.264 for WebCodecs, and MJPEG where it can't decode. */
const allowedPaths = [
  new RegExp(`^/vendor/serve-sim/helper/${udid}/stream\\.(avcc|mjpeg)$`),
]

/** The viewer's touch and keyboard input. */
const allowedSocketPaths = [/^\/vendor\/serve-sim\/helper\/ws$/]

/** The only query the viewer sends: which device the input socket drives. */
const forwardedQuery = ["device"]

export interface HubRequest {
  readonly method: string
  /** The request's path and query, starting at the proxy's mount point. */
  readonly url: string
  readonly isUpgrade: boolean
  readonly header: (name: string) => string | undefined
}

export type HubRoute =
  | { readonly status: 401 | 403 | 404 | 405 | 503 }
  | { readonly upstream: string; readonly hub: HubEndpoint }

/**
 * Where a request goes, checked in T3 Code's order: the allowlist first, so
 * any other route is a 404 with or without auth, then the method, then the
 * access token, then whether the hub runs.
 */
export function routeHubRequest(
  request: HubRequest,
  access: StreamAccess | undefined,
  stream: DeviceStream | undefined
): HubRoute {
  const url = new URL(request.url, "http://nitpick.invalid")
  const hubPath = url.pathname.slice(deviceHubRoutePrefix.length)
  const allowed = (request.isUpgrade ? allowedSocketPaths : allowedPaths).some(
    (pattern) => pattern.test(hubPath)
  )
  if (!url.pathname.startsWith(`${deviceHubRoutePrefix}/`) || !allowed) {
    return { status: 404 }
  }
  // The viewer only reads: no route it needs takes another method.
  if (request.method !== "GET") return { status: 405 }
  if (access === undefined || !access.admits(request.header)) {
    return { status: 401 }
  }
  // WebSockets skip CORS, so a page on another origin of the same site,
  // which the SameSite cookie doesn't stop, mustn't open the input socket.
  if (request.isUpgrade && !isSameOrigin(request.header)) {
    return { status: 403 }
  }
  const hub = stream?.endpoint()
  if (hub === undefined) return { status: 503 }
  const query = new URLSearchParams()
  for (const name of forwardedQuery) {
    const value = url.searchParams.get(name)
    if (value !== null) query.set(name, value)
  }
  const search = query.size > 0 ? `?${query.toString()}` : ""
  return { upstream: `${hub.origin}${hubPath}${search}`, hub }
}

/** The `Origin` header, when the client sent one, names this server. */
function isSameOrigin(header: HubRequest["header"]): boolean {
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
 * screen goes still.
 */
export async function proxyHubHTTP(
  request: Request,
  route: Extract<HubRoute, { upstream: string }>
): Promise<Response> {
  let upstream: Response
  try {
    upstream = await fetch(route.upstream, {
      headers: { authorization: `Bearer ${route.hub.token}` },
      signal: request.signal,
    })
  } catch {
    return refusal(502)
  }
  // The hub refusing its own token means it restarted under the request.
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel()
    return refusal(503)
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
  return new Response(body && endingWithViewer(body, request.signal), {
    status: upstream.status,
    headers,
  })
}

/**
 * A viewer leaving aborts the hub's response under the stream; that ends the
 * stream rather than failing it, so the server logs no error for it.
 */
function endingWithViewer(
  body: ReadableStream<Uint8Array>,
  viewer: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          if (viewer.aborted) controller.close()
          else controller.error(error)
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 }
  )
}

export function refusal(status: number): Response {
  return new Response(STATUS_CODES[status] ?? "Refused", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...(status === 405 && { Allow: "GET" }),
    },
  })
}

/**
 * The input socket: an upgrade the route allows opens the hub's socket with
 * the hub's token, and only then completes the browser's handshake, so the
 * browser never sees the hub's headers. Frames pass through unchanged.
 */
export function hubUpgradeHandler(
  access: StreamAccess | undefined,
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
      access,
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
      if (!piped) upstream.terminate()
    })
    upstream.once("open", () => {
      server.handleUpgrade(request, socket, head, (client) => {
        piped = true
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
