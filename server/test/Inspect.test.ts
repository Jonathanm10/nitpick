// Not a port: Inspect is new to the web app (ADR-0015). How the Device Host
// builds the Inspect library, launches an iOS Build with it on a port and
// secret of that launch's own, and asks the Build for its layout. The
// Build's side is a local HTTP server answering a recorded fixture, and
// simctl and clang are scripted, so nothing here needs Xcode.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import type { Build } from "@nitpick/core"
import { afterEach, describe, expect, test, vi } from "vitest"
import { androidSDK } from "../src/device/android.ts"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import {
  buildInspectLibrary,
  fetchLayout,
  InspectFailed,
  inspectLaunchEnvironment,
  inspectUnbuiltReason,
} from "../src/device/inspect.ts"
import { makeLocalDeviceHost } from "../src/device/LocalDeviceHost.ts"
import { launchBuild } from "../src/device/simctl.ts"
import type {
  SubprocessCommand,
  SubprocessResult,
  SubprocessRunner,
} from "../src/subprocess.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

/** The Build's side: answers `/layout` with `body` for `secret` alone. */
async function libraryServer(
  port: number,
  secret: string,
  body: Buffer | string = "{}"
): Promise<{ requests: string[] }> {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.headers.authorization !== `Bearer ${secret}`) {
      response
        .writeHead(401)
        .end('{"error":"The request has no valid secret."}')
      return
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve)
  )
  return { requests }
}

function shopAnswer(): Buffer {
  return gunzipSync(
    readFileSync(new URL("fixtures/layout/shop.json.gz", import.meta.url))
  )
}

/** Where a build command writes the library. */
function outputOf(command: SubprocessCommand): string {
  return command.arguments[command.arguments.indexOf("-o") + 1]
}

function ok(standardOutput = ""): SubprocessResult {
  return {
    exitCode: 0,
    standardOutput: Buffer.from(standardOutput),
    standardError: Buffer.alloc(0),
  }
}

describe("building the Inspect library", () => {
  test("compiles for the simulator once, and reuses the library while the source stays the same", async () => {
    const directory = temporaryDirectory()
    const source = join(temporaryDirectory(), "Inspector.m")
    writeFileSync(source, "// v1")
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 0,
      effect: (command) => writeFileSync(outputOf(command), "dylib"),
    })

    const first = await buildInspectLibrary(runner, directory, source)
    const second = await buildInspectLibrary(runner, directory, source)

    expect(runner.executedCommands).toHaveLength(1)
    const [command] = runner.executedCommands
    expect(command.executablePath).toBe("/usr/bin/xcrun")
    expect(command.arguments.slice(0, 7)).toEqual([
      "--sdk",
      "iphonesimulator",
      "clang",
      "-arch",
      "arm64",
      "-arch",
      "x86_64",
    ])
    expect(command.arguments.at(-1)).toBe(source)
    expect(first).toEqual(second)
    expect(first.status === "built" && first.path).toMatch(
      new RegExp(`^${directory}/[0-9a-f]{16}/libnitpickinspect.dylib$`)
    )
  })

  test("a changed source builds anew, and the old library goes", async () => {
    const directory = temporaryDirectory()
    const source = join(temporaryDirectory(), "Inspector.m")
    const runner = new FakeSubprocessRunner()
    for (let build = 0; build < 2; build++) {
      runner.enqueue({
        exitCode: 0,
        effect: (command) => writeFileSync(outputOf(command), "dylib"),
      })
    }
    writeFileSync(source, "// v1")
    const old = await buildInspectLibrary(runner, directory, source)
    writeFileSync(source, "// v2")

    const updated = await buildInspectLibrary(runner, directory, source)

    expect(runner.executedCommands).toHaveLength(2)
    expect(updated.status === "built" && existsSync(updated.path)).toBe(true)
    expect(old.status === "built" && existsSync(old.path)).toBe(false)
  })

  test("a failed build says why Inspect is off, and logs the compiler's error for the operator", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 1,
      standardError: "xcrun: error: SDK not found",
    })

    const built = await buildInspectLibrary(runner, temporaryDirectory())

    expect(built).toEqual({ status: "unbuilt", reason: inspectUnbuiltReason })
    expect(String(logged.mock.calls[0][0])).toContain("SDK not found")
  })
})

describe("launching with the library", () => {
  const build: Build = {
    identity: {
      bundleID: "dev.nitpick.fixture.acmestore",
      version: "1.0.0",
      buildNumber: "1",
    },
    appBundleURL: "file:///data/builds/b1/AcmeStore.app/",
  }
  const device: SimulatorDevice = {
    udid: "AAAA-1111",
    name: "iPhone 17 Pro",
    osName: "iOS 26.5",
    isBooted: false,
    isRuntimeAvailable: true,
  }

  test("simctl launch hands the Build the library, its port and its secret; the other steps are unchanged", async () => {
    const runner = new FakeSubprocessRunner()
    for (let step = 0; step < 4; step++) runner.enqueue({ exitCode: 0 })
    const environment = inspectLaunchEnvironment("/data/inspect/lib.dylib", {
      port: 50123,
      secret: "s".repeat(64),
    })

    await launchBuild(runner, build, device, environment)

    expect(environment).toEqual({
      SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: "/data/inspect/lib.dylib",
      SIMCTL_CHILD_NITPICK_INSPECT_PORT: "50123",
      SIMCTL_CHILD_NITPICK_INSPECT_SECRET: "s".repeat(64),
    })
    expect(
      runner.executedCommands.map((command) => command.environment)
    ).toEqual([undefined, undefined, undefined, environment])
    expect(runner.executedCommands[3].arguments).toEqual([
      "simctl",
      "launch",
      "AAAA-1111",
      "dev.nitpick.fixture.acmestore",
    ])
  })

  /**
   * simctl and clang as a host with Xcode answers them: the device boots,
   * and the library builds unless `buildFails`.
   */
  class HostRunner implements SubprocessRunner {
    readonly commands: SubprocessCommand[] = []
    booted = false
    buildFails = false

    async run(command: SubprocessCommand): Promise<SubprocessResult> {
      this.commands.push(command)
      const [first, , third] = command.arguments
      if (command.executablePath === "/usr/bin/xcode-select") {
        return ok("/Applications/Xcode.app/Contents/Developer\n")
      }
      if (third === "clang") {
        if (this.buildFails) {
          return { ...ok(), exitCode: 1, standardError: Buffer.from("no SDK") }
        }
        writeFileSync(outputOf(command), "dylib")
        return ok()
      }
      if (first === "simctl" && command.arguments[1] === "list") {
        return ok(
          JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
                {
                  udid: device.udid,
                  name: device.name,
                  state: this.booted ? "Booted" : "Shutdown",
                  isAvailable: true,
                },
              ],
            },
          })
        )
      }
      if (first === "simctl" && command.arguments[1] === "boot")
        this.booted = true
      if (first === "simctl") return ok()
      // No Android SDK here: the emulator isn't there to list.
      return { ...ok(), exitCode: 1 }
    }

    launches(): SubprocessCommand[] {
      return this.commands.filter(
        (command) => command.arguments[1] === "launch"
      )
    }
  }

  function localHost(runner: SubprocessRunner) {
    return makeLocalDeviceHost({
      runner,
      starter: {
        start: () => {
          throw new Error("nothing boots here")
        },
      },
      captureDirectory: temporaryDirectory(),
      android: androidSDK({ ANDROID_HOME: temporaryDirectory() }),
      ffmpeg: undefined,
      inspectDirectory: temporaryDirectory(),
    })
  }

  test("each launch takes a port and secret of its own, and Inspect asks that launch alone", async () => {
    const runner = new HostRunner()
    const host = localHost(runner)

    await host.launchBuild(build, device)
    await host.launchBuild(build, device)

    const [first, second] = runner
      .launches()
      .map((launch) => launch.environment!)
    expect(first.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toMatch(
      /libnitpickinspect\.dylib$/
    )
    expect(first.SIMCTL_CHILD_NITPICK_INSPECT_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(second.SIMCTL_CHILD_NITPICK_INSPECT_SECRET).not.toBe(
      first.SIMCTL_CHILD_NITPICK_INSPECT_SECRET
    )
    expect(
      runner.commands.filter((command) => command.arguments[2] === "clang")
    ).toHaveLength(1)
    // Only the second launch's Build runs now, as installing ended the first.
    const build2 = await libraryServer(
      Number(second.SIMCTL_CHILD_NITPICK_INSPECT_PORT),
      second.SIMCTL_CHILD_NITPICK_INSPECT_SECRET,
      shopAnswer()
    )

    const inspection = await host.inspectLayout(device.udid)

    expect(build2.requests).toEqual(["GET /layout"])
    expect(inspection.status).toBe("ready")
    expect(
      inspection.status === "ready" &&
        inspection.snapshot.elements.some(
          (element) => element.text?.content === "New this week"
        )
    ).toBe(true)
  })

  test("a host that can't build the library launches iOS Builds without it, and says why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const runner = new HostRunner()
    runner.buildFails = true
    const host = localHost(runner)

    const health = await host.checkHealth()
    await host.launchBuild(build, device)
    const inspection = await host.inspectLayout(device.udid)

    expect(health).toMatchObject({
      status: "ready",
      inspectProblem: inspectUnbuiltReason,
    })
    expect(runner.launches()[0].environment).toBeUndefined()
    expect(inspection).toEqual({
      status: "unavailable",
      reason: inspectUnbuiltReason,
    })
  })

  test("Inspect refuses a device that isn't booted, and one that runs no Build of nitpick's launching", async () => {
    const runner = new HostRunner()
    const host = localHost(runner)

    const stopped = host.inspectLayout(device.udid)
    await expect(stopped).rejects.toThrow(
      "iPhone 17 Pro is no longer running on the Device Host, so it can't be inspected."
    )
    runner.booted = true
    expect(await host.inspectLayout(device.udid)).toEqual({
      status: "unavailable",
      reason:
        "This Build was launched without Inspect. Resume review to relaunch it with Inspect.",
    })
  })
})

describe("asking the Build for its layout", () => {
  async function freePort(): Promise<number> {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    await new Promise((resolve) => server.close(resolve))
    return typeof address === "object" && address !== null ? address.port : 0
  }

  test("sends the launch's secret and answers the Build's layout", async () => {
    const port = await freePort()
    await libraryServer(port, "right", '{"screen":{}}')

    expect(await fetchLayout({ port, secret: "right" })).toEqual({ screen: {} })
  })

  test("a refusal, or no Build listening, is an InspectFailed in the Reviewer's words", async () => {
    const port = await freePort()
    await expect(fetchLayout({ port, secret: "anyone" })).rejects.toThrow(
      "The Build isn't answering Inspect: it may have quit or still be starting. Try again, or resume review to relaunch it."
    )
    await libraryServer(port, "right")

    const refused = fetchLayout({ port, secret: "wrong" })

    await expect(refused).rejects.toThrow(InspectFailed)
    await expect(refused).rejects.toThrow(
      "The Build couldn't read its layout for Inspect (status 401)."
    )
  })
})
