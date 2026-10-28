// Not a port: the hub proxy is new with the web app. In the style of T3
// Code's apps/server/src/device/DeviceHubProxy.test.ts (MIT): the allowlist,
// the methods and the auth matrix, then the stream and the input socket
// through a real server.
import { get } from "node:http"
import { connect, type AddressInfo } from "node:net"
import { serve, type ServerType } from "@hono/node-server"
import { afterEach, describe, expect, test } from "vitest"
import { WebSocket } from "ws"
import type { DeviceHost, SimulatorDevice } from "../src/device/DeviceHost.ts"
import { hubUpgradeHandler } from "../src/device/deviceHubProxy.ts"
import { signInCookieName } from "../src/reviewers.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeDeviceHub, mjpegPart } from "./FakeDeviceHub.ts"
import { signedInApp } from "./SignedIn.ts"

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

function emulator(running: { serial?: string } = {}): SimulatorDevice {
  return {
    udid: "nitpick-proof",
    name: "Pixel 10",
    osName: "Android 17",
    isBooted: running.serial !== undefined,
    isRuntimeAvailable: true,
    platform: "android",
    ...running,
  }
}

const serial = "emulator-5554"
/** serve-emu's WebRTC signaling, the only Android routes besides input. */
const signalingRoutes = [
  `/vendor/serve-emu/webrtc/offer?device=${serial}`,
  `/vendor/serve-emu/webrtc/close?device=${serial}`,
]

function posting(headers: Record<string, string>, body = "{}") {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  options: { streams?: boolean; devices?: SimulatorDevice[] } = {}
) {
  const hub = new FakeDeviceHub()
  await hub.listen()
  cleanups.push(() => hub.close())
  const list = async () => options.devices ?? [device]
  const deviceHost: DeviceHost = {
    id: "fake",
    label: "Fake host",
    devices: { list },
    checkHealth: async () => ({ status: "ready", devices: await list() }),
    launchBuild: async (_build, device) => device,
    readAndroidBuild: async () => {
      throw new Error("no .apk read here")
    },
    captureScreen: async () => {
      throw new Error("not captured here")
    },
    versions: async () => ({}),
  }
  const signedIn = signedInApp({
    data: temporaryDirectory(),
    deviceHost,
    deviceStream: options.streams === false ? undefined : hub,
  })
  const cookie = await signedIn.cookie()
  return {
    app: signedIn.server,
    hub,
    reviewers: signedIn.reviewers,
    signIns: signedIn.signIns,
    /** The headers of the signed-in browser. */
    signedIn: { cookie },
  }
}

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

  test.each(signalingRoutes)(
    "without auth, POST %s answers 401 and nothing reaches the hub",
    async (route) => {
      const { app, hub } = await fixture()

      const response = await app.request(`${proxy}${route}`, posting({}))

      expect(response.status).toBe(401)
      expect(hub.requests).toEqual([])
    }
  )

  test.each([
    ["no cookie", {}],
    ["a forged cookie", { cookie: `${signInCookieName}=forged` }],
    [
      "a sign-in ID the server never issued",
      { cookie: `${signInCookieName}=${"A".repeat(43)}` },
    ],
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

  test("a sign-in's ID as a Bearer token, or the cookie after sign-out, gets 401", async () => {
    const { app, hub, signedIn } = await fixture()
    const id = signedIn.cookie.slice(`${signInCookieName}=`.length)

    const asBearer = await app.request(`${proxy}${streamRoutes[0]}`, {
      headers: { authorization: `Bearer ${id}` },
    })
    const signOut = await app.request("/api/sign-out", {
      method: "POST",
      headers: signedIn,
    })
    const afterSignOut = await app.request(`${proxy}${streamRoutes[0]}`, {
      headers: signedIn,
    })

    expect([asBearer.status, signOut.status, afterSignOut.status]).toEqual([
      401, 204, 401,
    ])
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
    `/vendor/serve-emu/ws?device=${serial}`,
    "/vendor/serve-emu/api/devices",
    `/vendor/serve-emu/api/screenshot?device=${serial}`,
    `/vendor/serve-emu/api/apps/install?device=${serial}`,
    `/vendor/serve-emu/api/apps/launch?device=${serial}`,
    `/vendor/serve-emu/api/files/import?device=${serial}`,
    `/vendor/serve-emu/api/tap?device=${serial}`,
    `/vendor/serve-emu/api/text?device=${serial}`,
    `/vendor/serve-emu/api/location?device=${serial}`,
    `/vendor/serve-emu/api/stream-settings?device=${serial}`,
    `/vendor/serve-emu/api/stream-mode?device=${serial}`,
    "/vendor/serve-emu/api/avds/start",
    "/vendor/serve-emu/api/avds/stop",
    `/vendor/serve-emu/api/logcat?device=${serial}`,
    `/vendor/serve-emu/api?device=${serial}`,
    `/vendor/serve-emu/health?device=${serial}`,
    `/vendor/serve-emu/webrtc/stats?device=${serial}`,
    "/vendor/serve-emu/webrtc/offer",
    "/vendor/serve-emu/webrtc/offer?device=nitpick-proof",
    `/vendor/serve-emu/webrtc/offer?device=${serial}x`,
    `/vendor/serve-emu/webrtc/../api/apps/install?device=${serial}`,
    "/api/devices",
    "/api/devices/boot",
    "/",
    "",
  ])(
    "%s, outside the allowlist, answers 404 with or without auth",
    async (route) => {
      const { app, hub, signedIn } = await fixture()

      for (const headers of [{}, signedIn]) {
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
      const { app, hub, signedIn } = await fixture()

      for (const headers of [{}, signedIn]) {
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

  test.each(
    signalingRoutes.flatMap((route) =>
      ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"].map((method) => [
        method,
        route,
      ])
    )
  )(
    "%s on the signaling route %s answers 405 with or without auth",
    async (method, route) => {
      const { app, hub, signedIn } = await fixture()

      for (const headers of [{}, signedIn]) {
        const response = await app.request(`${proxy}${route}`, {
          method,
          headers,
        })
        expect(response.status).toBe(405)
        expect(response.headers.get("allow")).toBe("POST")
      }
      expect(hub.requests).toEqual([])
    }
  )

  test.each(signalingRoutes)(
    "POST %s from another origin of the same site answers 403",
    async (route) => {
      const { app, hub, signedIn } = await fixture()

      const response = await app.request(
        `${proxy}${route}`,
        posting({ ...signedIn, origin: "http://nitpick.test:5999" })
      )

      expect(response.status).toBe(403)
      expect(hub.requests).toEqual([])
    }
  )

  test("a hub that isn't running answers 503 to a signed-in request", async () => {
    const { app, hub, signedIn } = await fixture()
    hub.running = false

    const response = await app.request(`${proxy}${streamRoutes[0]}`, {
      headers: signedIn,
    })

    expect(response.status).toBe(503)
  })
})

describe("device hub proxy: forwarding", () => {
  test("signed in, a stream route reaches the hub with the hub's token, and no cookie or auth goes either way", async () => {
    const { app, hub, signedIn } = await fixture()
    const headers = { cookie: `${signedIn.cookie}; other=1` }

    const response = await app.request(
      `${proxy}${streamRoutes[0]}?token=guess&quality=1`,
      { headers }
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("frame")
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-hub-secret")).toBeNull()
    expect(hub.requests.map((request) => request.url)).toEqual([
      streamRoutes[0],
    ])
    const forwarded = hub.requests[0]!.headers
    expect(forwarded.authorization).toBe(`Bearer ${hub.token}`)
    expect(forwarded.cookie).toBeUndefined()
  })

  test("signed in, a WebRTC offer reaches serve-emu as JSON with the hub's token, and only its answer comes back", async () => {
    const { app, hub, signedIn } = await fixture()
    const offer = JSON.stringify({ type: "offer", sdp: "v=0 offer" })

    const response = await app.request(
      `${proxy}/vendor/serve-emu/webrtc/offer?device=${serial}&token=guess`,
      posting(
        {
          cookie: `${signedIn.cookie}; other=1`,
          host: "nitpick.test",
          origin: "http://nitpick.test",
        },
        offer
      )
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ type: "answer", sdp: "v=0 answer" })
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(
      hub.requests.map(({ method, url, body }) => ({ method, url, body }))
    ).toEqual([
      {
        method: "POST",
        url: `/vendor/serve-emu/webrtc/offer?device=${serial}`,
        body: offer,
      },
    ])
    const forwarded = hub.requests[0]!.headers
    expect(forwarded.authorization).toBe(`Bearer ${hub.token}`)
    expect(forwarded["content-type"]).toBe("application/json")
    expect(forwarded.cookie).toBeUndefined()
    expect(forwarded.origin).toBeUndefined()
  })

  test("an MJPEG stream re-sends its last frame once the screen goes still", async () => {
    const { app, signedIn } = await fixture()

    const response = await app.request(`${proxy}${streamRoutes[1]}`, {
      headers: signedIn,
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

  test("an open stream ends when its sign-in does", async () => {
    const { app, signedIn } = await fixture()
    const response = await app.request(`${proxy}${streamRoutes[1]}`, {
      headers: signedIn,
    })
    const reader = response.body!.getReader()
    await reader.read()

    const signOut = await app.request("/api/sign-out", {
      method: "POST",
      headers: signedIn,
    })
    let done = false
    for (let reads = 0; !done && reads < 100; reads++) {
      done = (await reader.read()).done
    }

    expect(signOut.status).toBe(204)
    expect(done).toBe(true)
  })

  test("a viewer that goes away releases its stream from the hub", async () => {
    const { app, hub, signedIn } = await fixture()
    const server = await listen(app)
    const { port } = server.address() as AddressInfo

    await new Promise<void>((resolve, reject) => {
      const request = get(
        `http://127.0.0.1:${port}/api/device-hub${streamRoutes[1]}`,
        { headers: signedIn },
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
    server.on(
      "upgrade",
      hubUpgradeHandler(
        (header) => context.reviewers.admit(header),
        context.hub
      )
    )
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

  test("signed in, binary input and the hub's admission frame pass through unchanged", async () => {
    const { hub, origin, signedIn } = await proxied()
    const { cookie } = signedIn

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

  test("an open socket closes when its sign-in ends, and input stops reaching the hub", async () => {
    const { app, hub, origin, signedIn } = await proxied()
    const opened = await open(`ws://${origin}${socketPath}`, {
      ...signedIn,
      origin: `http://${origin}`,
    })
    if (!("socket" in opened)) throw new Error(`refused ${opened.status}`)
    const closed = new Promise((resolve) =>
      opened.socket.once("close", resolve)
    )

    await app.request("/api/sign-out", { method: "POST", headers: signedIn })
    await closed
    opened.socket.send(Uint8Array.of(0x03, 9))

    expect(opened.socket.readyState).toBe(WebSocket.CLOSED)
    await eventually(() => expect(hub.socketRequests).toHaveLength(1))
    expect(opened.frames).toEqual([[0x83]])
  })

  test("an emulator's socket carries input only: the proxy asks serve-emu for no video", async () => {
    const { hub, origin, signedIn } = await proxied()

    const opened = await open(
      `ws://${origin}/api/device-hub/vendor/serve-emu/ws?device=${serial}&video=1&frame-meta=1`,
      { ...signedIn, origin: `http://${origin}` }
    )

    expect("socket" in opened).toBe(true)
    expect(hub.socketRequests.map((request) => request.url)).toEqual([
      `/vendor/serve-emu/ws?device=${serial}&video=0`,
    ])
    expect(hub.socketRequests[0]!.headers.authorization).toBe(
      `Bearer ${hub.token}`
    )
  })

  test.each([
    ["without a sign-in", {}, socketPath, 401],
    [
      "to an emulator without a sign-in",
      {},
      `/api/device-hub/vendor/serve-emu/ws?device=${serial}`,
      401,
    ],
    [
      "to an emulator from another origin",
      "foreign",
      `/api/device-hub/vendor/serve-emu/ws?device=${serial}`,
      403,
    ],
    [
      "to serve-emu without an emulator serial",
      "cookie",
      "/api/device-hub/vendor/serve-emu/ws?device=nitpick-proof",
      404,
    ],
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
      const { hub, origin, signedIn } = await proxied()
      const { cookie } = signedIn
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
    const { app, reviewers, hub } = await fixture()
    const server = await listen(app)
    server.on(
      "upgrade",
      hubUpgradeHandler((header) => reviewers.admit(header), hub)
    )
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

describe("the stream route", () => {
  test("without a hub, the stream is off", async () => {
    const { app, signedIn } = await fixture({ streams: false })

    const response = await app.request("/api/device-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn },
      body: JSON.stringify({ deviceUDID: udid }),
    })

    expect(response.status).toBe(503)
  })

  test("starting the stream needs a sign-in and a booted device", async () => {
    const { app, hub, signedIn } = await fixture()
    const start = (headers: Record<string, string>) =>
      app.request("/api/device-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ deviceUDID: udid }),
      })

    const refused = await start({})
    expect(refused.status).toBe(401)
    expect(await refused.json()).toMatchObject({ code: "signIn" })
    expect(hub.attached).toEqual([])

    const started = await start(signedIn)
    expect(started.status).toBe(200)
    expect(await started.json()).toEqual({ hubDevice: udid })
    expect(hub.attached).toEqual([udid])
  })

  test("an emulator streams by its serial, which serve-emu attaches itself", async () => {
    const { app, hub, signedIn } = await fixture({
      devices: [emulator({ serial: "emulator-5554" })],
    })

    const response = await app.request("/api/device-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn },
      body: JSON.stringify({ deviceUDID: "nitpick-proof" }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ hubDevice: "emulator-5554" })
    expect(hub.attached).toEqual([])
  })

  test("a device that stopped can't be streamed", async () => {
    const { app, hub, signedIn } = await fixture({
      devices: [{ ...device, isBooted: false }],
    })

    const response = await app.request("/api/device-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signedIn },
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
