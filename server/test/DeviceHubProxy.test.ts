// Not a port: the hub proxy is new with the web app. In the style of T3
// Code's apps/server/src/device/DeviceHubProxy.test.ts (MIT): the allowlist,
// the methods and the auth matrix, then the stream and the input socket
// through a real server.
import { get } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serve, type ServerType } from "@hono/node-server"
import { afterEach, describe, expect, test } from "vitest"
import { WebSocket } from "ws"
import { createApp } from "../src/app.ts"
import type { DeviceHost, SimulatorDevice } from "../src/device/DeviceHost.ts"
import { hubUpgradeHandler } from "../src/device/deviceHubProxy.ts"
import { HistoryStore } from "../src/historyStore.ts"
import { Reviewer } from "../src/reviewer.ts"
import { StreamAccess, streamAccessCookieName } from "../src/streamAccess.ts"
import { FakeDeviceHub, mjpegPart } from "./FakeDeviceHub.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const sharedToken = "shared-access-token-for-tests"
const udid = "C0FFEE00-0000-4000-8000-000000000009"
const proxy = "http://nitpick.test/api/device-hub"
const streamRoutes = [
  `/vendor/serve-sim/helper/${udid}/stream.avcc`,
  `/vendor/serve-sim/helper/${udid}/stream.mjpeg`,
]

const device: SimulatorDevice = {
  udid,
  name: "iPhone 17 Pro",
  osName: "iOS 26.5",
  isBooted: true,
  isRuntimeAvailable: true,
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  options: { access?: StreamAccess | null; devices?: SimulatorDevice[] } = {}
) {
  const hub = new FakeDeviceHub()
  await hub.listen()
  cleanups.push(() => hub.close())
  const access =
    options.access === null
      ? undefined
      : (options.access ?? new StreamAccess(sharedToken))
  const list = async () => options.devices ?? [device]
  const deviceHost: DeviceHost = {
    id: "fake",
    label: "Fake host",
    devices: { list },
    checkHealth: async () => ({ status: "ready", devices: await list() }),
    launchBuild: async () => {},
    captureScreen: async () => {
      throw new Error("not captured here")
    },
    versions: async () => ({}),
  }
  const history = new HistoryStore(join(tmpdir(), "nitpick-unused-history"))
  const app = createApp({
    deviceHost,
    reviewer: new Reviewer(join(tmpdir(), "nitpick-unused-reviewer"), {
      deviceHost,
      runner: new FakeSubprocessRunner(),
      youTrack: undefined,
      history,
    }),
    youTrack: undefined,
    history,
    serverVersion: "0.0.0",
    streamAccess: access,
    deviceStream: hub,
  })
  return { app, hub, access }
}

/** The cookie POST /api/stream-access sets, as the browser sends it back. */
async function browserCookie(app: Awaited<ReturnType<typeof fixture>>["app"]) {
  const response = await app.request("/api/stream-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: sharedToken }),
  })
  expect(response.status).toBe(204)
  return response.headers.get("set-cookie")!.split(";")[0]!
}

const bearer = { authorization: `Bearer ${sharedToken}` }

describe("device hub proxy: the auth and allowlist matrix", () => {
  test.each(streamRoutes)(
    "without auth, GET %s answers 401 and nothing reaches the hub",
    async (route) => {
      const { app, hub } = await fixture()

      const response = await app.request(`${proxy}${route}`)

      expect(response.status).toBe(401)
      expect(hub.requests).toEqual([])
    }
  )

  test.each([
    ["no token", {}],
    ["a wrong Bearer token", { authorization: "Bearer not-the-shared-token" }],
    ["a forged cookie", { cookie: `${streamAccessCookieName}=forged` }],
    [
      "the hub's own token",
      { authorization: "Bearer hub-token-from-startup-link" },
    ],
  ])("%s gets 401", async (_, headers) => {
    const { app, hub } = await fixture()

    const response = await app.request(`${proxy}${streamRoutes[0]}`, {
      headers,
    })

    expect(response.status).toBe(401)
    expect(hub.requests).toEqual([])
  })

  test("without a shared token set on the host, nothing authenticates", async () => {
    const { app, hub } = await fixture({ access: null })

    const response = await app.request(`${proxy}${streamRoutes[0]}`, {
      headers: bearer,
    })

    expect(response.status).toBe(401)
    expect(hub.requests).toEqual([])
  })

  test.each([
    "/vendor/serve-sim/exec",
    "/vendor/serve-sim/exec-ws",
    "/vendor/serve-sim/api",
    "/vendor/serve-sim/api/screenshot",
    "/vendor/serve-sim/grid/api/start",
    "/vendor/serve-sim/network-capture",
    `/vendor/serve-sim/helper/${udid}/config`,
    `/vendor/serve-sim/helper/${udid}/ax`,
    `/vendor/serve-sim/helper/${udid}/webrtc/offer`,
    "/vendor/serve-sim/helper/not-a-udid/stream.mjpeg",
    `/vendor/serve-sim/helper/${udid.toLowerCase()}/stream.mjpeg`,
    `/vendor/serve-sim/helper/${udid}/../../exec`,
    `/vendor/serve-sim/helper/${udid}/%2e%2e/%2e%2e/exec`,
    "/vendor/serve-sim/helper/ws",
    "/vendor/serve-emu/ws",
    "/vendor/serve-emu/api/devices",
    "/api/devices",
    "/api/devices/boot",
    "/",
    "",
  ])(
    "%s, outside the allowlist, answers 404 with or without auth",
    async (route) => {
      const { app, hub } = await fixture()
      const cookie = await browserCookie(app)

      for (const headers of [{}, bearer, { cookie }]) {
        for (const method of ["GET", "POST"]) {
          const response = await app.request(`${proxy}${route}`, {
            method,
            headers,
          })
          expect(response.status, `${method} ${JSON.stringify(headers)}`).toBe(
            404
          )
        }
      }
      expect(hub.requests).toEqual([])
    }
  )

  test.each(
    streamRoutes.flatMap((route) =>
      ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) => [
        method,
        route,
      ])
    )
  )(
    "%s on the read route %s answers 405 with or without auth",
    async (method, route) => {
      const { app, hub } = await fixture()

      for (const headers of [{}, bearer]) {
        const response = await app.request(`${proxy}${route}`, {
          method,
          headers,
        })
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toBe("GET")
      }
      expect(hub.requests).toEqual([])
    }
  )

  test("a hub that isn't running answers 503 to an authenticated request", async () => {
    const { app, hub } = await fixture()
    hub.running = false

    const response = await app.request(`${proxy}${streamRoutes[0]}`, {
      headers: bearer,
    })

    expect(response.status).toBe(503)
  })
})

describe("device hub proxy: forwarding", () => {
  test.each(["a Bearer token", "the browser's cookie"])(
    "with %s, a stream route reaches the hub with the hub's token, and no cookie or auth goes either way",
    async (credentials) => {
      const { app, hub } = await fixture()
      const headers =
        credentials === "a Bearer token"
          ? { ...bearer, cookie: "other=1" }
          : { cookie: `${await browserCookie(app)}; other=1` }

      const response = await app.request(
        `${proxy}${streamRoutes[0]}?token=guess&quality=1`,
        { headers }
      )

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("frame")
      expect(response.headers.get("cache-control")).toBe(
        "no-store, no-transform"
      )
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(response.headers.get("x-hub-secret")).toBeNull()
      expect(hub.requests.map((request) => request.url)).toEqual([
        streamRoutes[0],
      ])
      const forwarded = hub.requests[0]!.headers
      expect(forwarded.authorization).toBe(`Bearer ${hub.token}`)
      expect(forwarded.cookie).toBeUndefined()
    }
  )

  test("an MJPEG stream re-sends its last frame once the screen goes still", async () => {
    const { app } = await fixture()

    const response = await app.request(`${proxy}${streamRoutes[1]}`, {
      headers: bearer,
    })
    const reader = response.body!.getReader()
    const received: Buffer[] = []
    const part = mjpegPart("jpeg-1")
    while (Buffer.concat(received).length < part.length * 2) {
      const { value } = await reader.read()
      received.push(Buffer.from(value!))
    }
    await reader.cancel()

    expect(response.headers.get("content-type")).toBe(
      "multipart/x-mixed-replace; boundary=frame"
    )
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
    expect(Buffer.concat(received)).toEqual(Buffer.concat([part, part]))
  })

  test("a viewer that goes away releases its stream from the hub", async () => {
    const { app, hub } = await fixture()
    const server = await listen(app)
    const { port } = server.address() as AddressInfo

    await new Promise<void>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${port}/api/device-hub${streamRoutes[1]}`,
        { headers: bearer },
        (response) => {
          response.once("data", () => {
            request.destroy()
            resolve()
          })
        }
      )
      request.on("error", () => {})
      request.on("close", resolve)
      setTimeout(() => reject(new Error("no frame")), 5000)
    })
    await eventually(() => expect(hub.closed).toEqual([streamRoutes[1]]))
  })
})

describe("device hub proxy: the input socket", () => {
  const socketPath = `/api/device-hub/vendor/serve-sim/helper/ws?device=${udid}&token=guess`

  async function proxied() {
    const context = await fixture()
    const server = await listen(context.app)
    server.on("upgrade", hubUpgradeHandler(context.access, context.hub))
    const { port } = server.address() as AddressInfo
    return { ...context, origin: `127.0.0.1:${port}` }
  }

  /** Opens a socket, collecting its frames from the first one on. */
  function open(url: string, headers: Record<string, string>) {
    const socket = new WebSocket(url, { headers })
    cleanups.push(() => socket.terminate())
    const frames: number[][] = []
    socket.on("message", (data: Buffer) => frames.push([...data]))
    return new Promise<
      { socket: WebSocket; frames: number[][] } | { status: number }
    >((resolve) => {
      socket.once("open", () => resolve({ socket, frames }))
      socket.once("unexpected-response", (_, response) =>
        resolve({ status: response.statusCode ?? 0 })
      )
      socket.once("error", () => {})
    })
  }

  test("with the cookie, binary input and the hub's admission frame pass through unchanged", async () => {
    const { app, hub, origin } = await proxied()
    const cookie = await browserCookie(app)

    const opened = await open(`ws://${origin}${socketPath}`, {
      cookie,
      origin: `http://${origin}`,
    })
    if (!("socket" in opened)) throw new Error(`refused ${opened.status}`)
    const { socket, frames } = opened
    await eventually(() => expect(frames).toEqual([[0x83]]))
    socket.send(Uint8Array.of(0x03, 1))
    socket.send(Uint8Array.of(0x06, 2))
    await eventually(() =>
      expect(frames).toEqual([[0x83], [0x03, 1], [0x06, 2]])
    )
    expect(hub.socketRequests.map((request) => request.url)).toEqual([
      `/vendor/serve-sim/helper/ws?device=${udid}`,
    ])
    const forwarded = hub.socketRequests[0]!.headers
    expect(forwarded.authorization).toBe(`Bearer ${hub.token}`)
    expect(forwarded.cookie).toBeUndefined()
  })

  test.each([
    ["without auth", {}, socketPath, 401],
    ["from another origin of the same site", "foreign", socketPath, 403],
    [
      "to serve-sim's exec socket",
      "cookie",
      `/api/device-hub/vendor/serve-sim/exec-ws?device=${udid}`,
      404,
    ],
    [
      "to the hub's device list",
      "cookie",
      "/api/device-hub/api/devices/ws",
      404,
    ],
    ["outside the proxy", "cookie", "/api/review", 404],
  ] as const)(
    "an upgrade %s is refused before the hub sees it",
    async (_, credentials, path, status) => {
      const { app, hub, origin } = await proxied()
      const cookie = await browserCookie(app)
      const headers =
        credentials === "cookie"
          ? { cookie }
          : credentials === "foreign"
            ? { cookie, origin: "http://127.0.0.1:5999" }
            : credentials

      expect(await open(`ws://${origin}${path}`, headers)).toEqual({ status })
      expect(hub.socketRequests).toEqual([])
    }
  )
})

describe("the input socket: a target no URL parses", () => {
  test("is refused, and the server keeps answering", async () => {
    const { app, access, hub } = await fixture()
    const server = await listen(app)
    server.on("upgrade", hubUpgradeHandler(access, hub))
    const { port } = server.address() as AddressInfo

    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write(
          "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        )
      )
      let received = ""
      socket.on("data", (data) => (received += data.toString()))
      socket.on("close", () => resolve(received))
      socket.on("error", reject)
    })

    expect(answer).toMatch(/^HTTP\/1\.1 404 /)
    const still = await fetch(`http://127.0.0.1:${port}/api/device-hub/`)
    expect(still.status).toBe(404)
    expect(hub.socketRequests).toEqual([])
  })
})

describe("the access and stream routes", () => {
  test("a wrong token gets 401 and no cookie; the right one an HttpOnly, SameSite cookie for /api", async () => {
    const { app } = await fixture()

    const wrong = await app.request("/api/stream-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-the-shared-token" }),
    })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({
      error: "That isn't the Device Host's access token.",
      code: "streamAccess",
    })
    expect(wrong.headers.get("set-cookie")).toBeNull()

    const right = await app.request("/api/stream-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: sharedToken }),
    })
    const cookie = right.headers.get("set-cookie")!
    expect(cookie).toMatch(
      new RegExp(
        `^${streamAccessCookieName}=[A-Za-z0-9_-]+; Path=/api; Max-Age=2592000; HttpOnly; SameSite=Strict$`
      )
    )
    expect(cookie).not.toContain(sharedToken)
  })

  test("without a shared token set, the stream is off", async () => {
    const { app } = await fixture({ access: null })

    for (const [path, body] of [
      ["/api/stream-access", { token: sharedToken }],
      ["/api/device-stream", { deviceUDID: udid }],
    ] as const) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(503)
    }
  })

  test("starting the stream needs the cookie and a booted device", async () => {
    const { app, hub } = await fixture()
    const start = (headers: Record<string, string>) =>
      app.request("/api/device-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ deviceUDID: udid }),
      })

    const refused = await start({})
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ code: "streamAccess" })

    expect((await start({ cookie: await browserCookie(app) })).status).toBe(204)
    expect(hub.attached).toEqual([udid])
  })

  test("a device that stopped can't be streamed", async () => {
    const { app, hub } = await fixture({
      devices: [{ ...device, isBooted: false }],
    })

    const response = await app.request("/api/device-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer },
      body: JSON.stringify({ deviceUDID: udid }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error:
        "iPhone 17 Pro is no longer running on the Device Host, so it can't be shown. Resume review to relaunch the Build.",
      code: "deviceNotRunning",
    })
    expect(hub.attached).toEqual([])
  })
})

async function listen(
  app: Awaited<ReturnType<typeof fixture>>["app"]
): Promise<ServerType> {
  const server = await new Promise<ServerType>((resolve) => {
    const started: ServerType = serve(
      { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
      () => resolve(started)
    )
  })
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        if ("closeAllConnections" in server) server.closeAllConnections()
      })
  )
  return server
}

async function eventually(check: () => void, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
}
