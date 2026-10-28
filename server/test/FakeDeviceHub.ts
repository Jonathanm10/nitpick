import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { WebSocketServer, type WebSocket } from "ws"
import type { DeviceStream, HubEndpoint } from "../src/device/deviceHub.ts"

export interface HubRequestRecord {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  /** What a POST carried, once it arrived. */
  body?: string
}

/** One MJPEG part as the hub frames it: one write each. */
export function mjpegPart(body: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    ),
    Buffer.from(body),
    Buffer.from("\r\n"),
  ])
}

/**
 * A stand-in for expo-device-hub on loopback, recording what reaches it.
 * Its MJPEG stream sends one part and stays open, as a still screen does;
 * its AVCC stream answers a short body with a cookie the proxy must drop;
 * its input socket admits input and echoes every frame back.
 */
export class FakeDeviceHub implements DeviceStream {
  readonly token = "hub-token-from-startup-link"
  readonly requests: HubRequestRecord[] = []
  readonly socketRequests: HubRequestRecord[] = []
  /** Requests whose connection closed, by URL. */
  readonly closed: string[] = []
  running = true
  readonly attached: string[] = []
  readonly #server: Server
  readonly #sockets = new WebSocketServer({ noServer: true })
  readonly #clients = new Set<WebSocket>()

  constructor() {
    this.#server = createServer((request, response) => {
      const record: HubRequestRecord = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
      }
      this.requests.push(record)
      request.on("close", () => this.closed.push(request.url ?? ""))
      if (request.method === "POST") {
        // serve-emu's WebRTC signaling: JSON in, JSON out.
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
          record.body = Buffer.concat(chunks).toString("utf8")
          response.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": "hub_session=1",
          })
          response.end(JSON.stringify({ type: "answer", sdp: "v=0 answer" }))
        })
        return
      }
      if (request.url?.endsWith("/stream.mjpeg")) {
        response.writeHead(200, {
          "Content-Type": "multipart/x-mixed-replace; boundary=frame",
          "Cache-Control": "no-cache",
          "Set-Cookie": "hub_session=1",
        })
        response.write(mjpegPart("jpeg-1"))
        return
      }
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Set-Cookie": "hub_session=1",
        "X-Hub-Secret": "never forwarded",
      })
      response.end("frame")
    })
    this.#server.on("upgrade", (request, socket, head) => {
      this.socketRequests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
      })
      this.#sockets.handleUpgrade(request, socket, head, (client) => {
        this.#clients.add(client)
        client.on("close", () => this.#clients.delete(client))
        client.send(Uint8Array.of(0x83))
        client.on("message", (data, isBinary) =>
          client.send(data, { binary: isBinary })
        )
      })
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.#server.listen(0, "127.0.0.1", resolve)
    )
  }

  endpoint(): HubEndpoint | undefined {
    if (!this.running) return undefined
    const { port } = this.#server.address() as AddressInfo
    return { origin: `http://127.0.0.1:${port}`, token: this.token }
  }

  async attach(deviceUDID: string): Promise<void> {
    this.attached.push(deviceUDID)
  }

  async close(): Promise<void> {
    for (const client of this.#clients) client.terminate()
    this.#server.closeAllConnections()
    await new Promise((resolve) => this.#server.close(resolve))
  }
}
