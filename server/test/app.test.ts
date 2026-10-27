import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, onTestFinished, test, vi } from "vitest"
import { createApp } from "../src/app.ts"
import type { DeviceHost, SimulatorDevice } from "../src/device/DeviceHost.ts"

const device: SimulatorDevice = {
  udid: "CCCC-3333",
  name: "iPhone Air",
  osName: "iOS 26.5",
  isBooted: true,
  isRuntimeAvailable: true,
}

function hostListing(list: DeviceHost["devices"]["list"]): DeviceHost {
  return { id: "fake", label: "Fake host", devices: { list } }
}

describe("HTTP app", () => {
  test("GET /api/devices returns the Device Host's devices", async () => {
    const app = createApp({ deviceHost: hostListing(async () => [device]) })

    const response = await app.request("/api/devices")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ devices: [device] })
  })

  test("a failed listing is a 500 carrying the error's message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const app = createApp({
      deviceHost: hostListing(async () => {
        throw new Error("The simulator device list could not be read.")
      }),
    })

    const response = await app.request("/api/devices")

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: "The simulator device list could not be read.",
    })
  })

  test("the built web app is served from its root", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "nitpick-web-"))
    onTestFinished(() => rmSync(webRoot, { recursive: true }))
    writeFileSync(join(webRoot, "index.html"), "<title>nitpick</title>")
    const app = createApp({ deviceHost: hostListing(async () => []), webRoot })

    const response = await app.request("/")

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<title>nitpick</title>")
  })
})
