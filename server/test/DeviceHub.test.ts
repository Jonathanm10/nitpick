// Not a port: the supervised hub is new with the web app, after T3 Code's
// LocalDeviceHost (MIT). A stand-in hub process prints the pinned CLI's
// startup link, so the supervisor runs against real child processes.
import { spawn } from "node:child_process"
import { afterEach, describe, expect, test } from "vitest"
import { DeviceHub } from "../src/device/deviceHub.ts"

/**
 * Listens on the port it's given, prints the link the pinned CLI prints
 * with a fresh token, and reports each attach it gets, Authorization and all.
 */
const fakeHub = `
const { createServer } = require("node:http")
const { randomBytes } = require("node:crypto")
const port = Number(process.argv[1])
const token = randomBytes(12).toString("base64url")
createServer((request, response) => {
  let body = ""
  request.on("data", (chunk) => (body += chunk))
  request.on("end", () => {
    console.log("attach " + request.url + " " + request.headers.authorization + " " + body)
    const ok = !body.includes("REFUSED")
    response.end(JSON.stringify(ok ? { ok } : { ok, error: "no such device" }))
  })
}).listen(port, "127.0.0.1", () => {
  console.log("fake hub pid " + process.pid)
  console.log("Expo Device Hub ready")
  console.log("  Local:   http://localhost:" + port + "/?token=" + token)
  console.error("stderr also mentions " + token)
})
`

/** A hub that never prints its link. */
const silentHub = `setInterval(() => {}, 1000)`

const hubs: DeviceHub[] = []
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop()
})

function supervise(script: string, readyTimeoutMilliseconds?: number) {
  const log: string[] = []
  const hub = new DeviceHub({
    spawn: (port) => spawn(process.execPath, ["-e", script, String(port)]),
    log: (line) => log.push(line),
    readyTimeoutMilliseconds,
  })
  hubs.push(hub)
  hub.start()
  return { hub, log }
}

function pids(log: string[]): number[] {
  return log.flatMap((line) => {
    const match = /^fake hub pid (\d+)$/.exec(line)
    return match === null ? [] : [Number(match[1])]
  })
}

async function eventually(check: () => void, timeout = 5000): Promise<void> {
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

describe("device hub supervisor", () => {
  test("the hub's loopback origin and token come from its startup link, and no log line shows the token", async () => {
    const { hub, log } = supervise(fakeHub)

    const endpoint = await hub.ready()

    expect(endpoint?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(endpoint?.token).toMatch(/^[A-Za-z0-9_-]{16}$/)
    await eventually(() => expect(log).toContain("stderr also mentions …"))
    expect(log).toContain(
      `  Local:   http://localhost:${new URL(endpoint!.origin).port}/?token=…`
    )
    expect(log.join("\n")).not.toContain(endpoint!.token)
  })

  test("a hub crash restarts the hub, with a new token, and the supervisor keeps running", async () => {
    const { hub, log } = supervise(fakeHub)
    const first = await hub.ready()
    const [firstPID] = pids(log)

    process.kill(firstPID!, "SIGKILL")
    await eventually(() => expect(pids(log)).toHaveLength(2))
    const second = await hub.ready()

    expect(second).toBeDefined()
    expect(second!.token).not.toBe(first!.token)
    expect(
      log.some((line) => line.startsWith("The device hub exited (SIGKILL)"))
    ).toBe(true)
    expect(await (await fetch(`${second!.origin}/alive`)).json()).toEqual({
      ok: true,
    })
  })

  test("a hub that never reports its link is restarted", async () => {
    const { log } = supervise(silentHub, 150)

    await eventually(() =>
      expect(
        log.filter((line) => line.startsWith("The device hub exited"))
      ).toHaveLength(2)
    )
    expect(log).toContain("The device hub didn't start in time; restarting it.")
  })

  test("stopping stops the hub for good", async () => {
    const { hub, log } = supervise(fakeHub)
    await hub.ready()
    const [pid] = pids(log)

    await hub.stop()

    expect(() => process.kill(pid!, 0)).toThrow()
    expect(hub.endpoint()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(pids(log)).toHaveLength(1)
  })

  test("attaching a device asks the hub's grid with the hub's token", async () => {
    const { hub, log } = supervise(fakeHub)

    await hub.attach("C0FFEE00-0000-4000-8000-000000000009")
    await expect(hub.attach("REFUSED")).rejects.toThrow(
      "The Device Host can't stream the device: no such device"
    )

    expect(log).toContain(
      'attach /vendor/serve-sim/grid/api/start Bearer … {"udid":"C0FFEE00-0000-4000-8000-000000000009"}'
    )
  })
})
