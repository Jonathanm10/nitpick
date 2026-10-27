// Ports Tests/NitpickCoreTests/SimulatorDeviceTests.swift.
import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, test } from "vitest"
import {
  listSimulatorDevices,
  MalformedDeviceList,
} from "../src/device/simctl.ts"
import { SubprocessFailure } from "../src/subprocess.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

// The Swift suite's device list, in the format `simctl list devices --json`
// prints; the first record carries every key a real one has. Values are
// fictional.
const deviceListJSON = readFileSync(
  new URL("./fixtures/simctl-list-devices.json", import.meta.url),
  "utf8"
)

describe("Simulator device listing", () => {
  let runner: FakeSubprocessRunner

  beforeEach(() => {
    runner = new FakeSubprocessRunner()
  })

  test("iOS devices are listed newest OS first, runtime-missing devices flagged, watchOS dropped", async () => {
    runner.enqueue({ exitCode: 0, standardOutput: deviceListJSON })

    const devices = await listSimulatorDevices(runner)

    expect(runner.executedCommands).toEqual([
      {
        executablePath: "/usr/bin/xcrun",
        arguments: ["simctl", "list", "devices", "--json"],
      },
    ])
    expect(devices).toEqual([
      {
        udid: "DDDD-4444",
        name: "iPad (A16)",
        osName: "iOS 26.5",
        isBooted: false,
        isRuntimeAvailable: true,
      },
      {
        udid: "CCCC-3333",
        name: "iPhone Air",
        osName: "iOS 26.5",
        isBooted: true,
        isRuntimeAvailable: true,
      },
      {
        udid: "BBBB-2222",
        name: "Broken iPhone",
        osName: "iOS 26.4",
        isBooted: false,
        isRuntimeAvailable: false,
      },
      {
        udid: "AAAA-1111",
        name: "iPhone 17 Pro",
        osName: "iOS 26.4",
        isBooted: false,
        isRuntimeAvailable: true,
      },
    ])
  })

  test("a simctl failure surfaces as a subprocess failure", async () => {
    runner.enqueue({ exitCode: 1, standardError: "simctl: no developer dir" })

    await expect(listSimulatorDevices(runner)).rejects.toThrow(
      SubprocessFailure
    )
  })

  test("unparseable simctl output is a clear error", async () => {
    runner.enqueue({ exitCode: 0, standardOutput: "garbage" })

    await expect(listSimulatorDevices(runner)).rejects.toThrow(
      new MalformedDeviceList()
    )
  })
})

// Not in the Swift suite: where a TypeScript port could drift from Swift's
// Int and JSONDecoder.
describe("Simulator device listing, port checks", () => {
  test("OS versions compare as numbers, so iOS 26.10 sorts before iOS 26.9", async () => {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 0,
      standardOutput: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-9": [
            { udid: "A", name: "iPhone", state: "Shutdown" },
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-10": [
            { udid: "B", name: "iPhone", state: "Shutdown" },
          ],
        },
      }),
    })

    const devices = await listSimulatorDevices(runner)

    expect(devices.map((device) => device.osName)).toEqual([
      "iOS 26.10",
      "iOS 26.9",
    ])
  })

  test("a device record missing a required field makes the list malformed", async () => {
    const runner = new FakeSubprocessRunner()
    runner.enqueue({
      exitCode: 0,
      standardOutput: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
            { udid: "A", state: "Shutdown" },
          ],
        },
      }),
    })

    await expect(listSimulatorDevices(runner)).rejects.toThrow(
      MalformedDeviceList
    )
  })
})
