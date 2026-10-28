// Ports Tests/NitpickCoreTests/SetupGuidanceTests.swift as the Device Host's
// health check. Reviewers can't fix the host, so a problem carries a reason
// and no install steps: those move to the ops runbook (issue 12). The
// xcodeVersion cases feed Feedback's Environment, which is issue 08's.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Build } from "@nitpick/core"
import { build as plistXML } from "plist"
import { beforeEach, describe, expect, test } from "vitest"
import type { HostHealth } from "../src/device/DeviceHost.ts"
import {
  checkHostHealth,
  hostProblemReason,
  macOSVersion,
  xcodeVersion,
} from "../src/device/hostHealth.ts"
import { launchBuild, RuntimeUnavailable } from "../src/device/simctl.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const deviceListJSON = readFileSync(
  new URL("./fixtures/simctl-list-devices.json", import.meta.url),
  "utf8"
)

const xcodeSelect = {
  executablePath: "/usr/bin/xcode-select",
  arguments: ["-p"],
}
const simctlList = {
  executablePath: "/usr/bin/xcrun",
  arguments: ["simctl", "list", "devices", "--json"],
}

function reason(health: HostHealth): string {
  if (health.status !== "notReady") {
    throw new Error(`expected a host problem, got ${health.status}`)
  }
  return hostProblemReason(health.problem)
}

describe("Setup guidance", () => {
  let runner: FakeSubprocessRunner

  beforeEach(() => {
    runner = new FakeSubprocessRunner()
  })

  test("no active developer directory: the reason names Xcode, nothing else is probed", async () => {
    runner.enqueue({
      exitCode: 2,
      standardError:
        "xcode-select: error: unable to get active developer directory",
    })

    const health = await checkHostHealth(runner)

    expect(runner.executedCommands).toEqual([xcodeSelect])
    expect(health).toEqual({
      status: "notReady",
      problem: { kind: "xcodeNotInstalled" },
    })
    expect(reason(health)).toContain("Xcode isn't installed on the Device Host")
  })

  test("Command Line Tools selected instead of Xcode: the reason names the full-Xcode need, simctl is never run", async () => {
    runner.enqueue({
      exitCode: 0,
      standardOutput: "/Library/Developer/CommandLineTools\n",
    })

    const health = await checkHostHealth(runner)

    expect(runner.executedCommands).toEqual([xcodeSelect])
    expect(health).toEqual({
      status: "notReady",
      problem: {
        kind: "commandLineToolsOnly",
        developerDirectory: "/Library/Developer/CommandLineTools",
      },
    })
    expect(reason(health)).toContain("Command Line Tools")
  })

  test("Xcode selected but simctl broken: setup incomplete, the raw tool error never leaks", async () => {
    const rawToolError = "You have not agreed to the Xcode license agreements"
    runner.enqueue({
      exitCode: 0,
      standardOutput: "/Applications/Xcode.app/Contents/Developer\n",
    })
    runner.enqueue({ exitCode: 69, standardError: rawToolError })

    const health = await checkHostHealth(runner)

    expect(runner.executedCommands).toEqual([xcodeSelect, simctlList])
    expect(health).toEqual({
      status: "notReady",
      problem: { kind: "xcodeSetupIncomplete" },
    })
    expect(reason(health)).toContain("Xcode")
    expect(reason(health)).not.toContain(rawToolError)
  })

  test("simctl healthy but no usable iOS device: the reason names the missing iOS platform", async () => {
    // A watchOS runtime and an iOS device whose runtime was deleted: nothing
    // a review could boot.
    runner.enqueue({
      exitCode: 0,
      standardOutput: "/Applications/Xcode.app/Contents/Developer\n",
    })
    runner.enqueue({
      exitCode: 0,
      standardOutput: JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.watchOS-12-0": [
            {
              udid: "EEEE-5555",
              name: "Apple Watch Ultra 3",
              state: "Shutdown",
              isAvailable: true,
            },
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
            {
              udid: "BBBB-2222",
              name: "Broken iPhone",
              state: "Shutdown",
              isAvailable: false,
              availabilityError: "runtime profile not found",
            },
          ],
        },
      }),
    })

    const health = await checkHostHealth(runner)

    expect(health).toEqual({
      status: "notReady",
      problem: { kind: "missingIOSRuntime" },
    })
    expect(reason(health)).toContain("iOS")
  })

  test("prerequisites present: the check hands back the pickable devices and no problem", async () => {
    runner.enqueue({
      exitCode: 0,
      standardOutput: "/Applications/Xcode.app/Contents/Developer\n",
    })
    runner.enqueue({ exitCode: 0, standardOutput: deviceListJSON })

    const health = await checkHostHealth(runner)

    expect(runner.executedCommands).toEqual([xcodeSelect, simctlList])
    if (health.status !== "ready") throw new Error("expected a ready host")
    // The runtime-missing device stays in the list, flagged: the pick-time
    // story, while the check stays problem-free.
    expect(health.devices.map((device) => device.name)).toEqual([
      "iPad (A16)",
      "iPhone Air",
      "Broken iPhone",
      "iPhone 17 Pro",
    ])
    expect(health.devices.map((device) => device.isRuntimeAvailable)).toEqual([
      true,
      true,
      false,
      true,
    ])
  })

  test("a runtime-missing device is refused at launch, before any boot is attempted", async () => {
    const build: Build = {
      identity: {
        bundleID: "ch.liip.reviewme",
        version: "2.1.0",
        buildNumber: "421",
      },
      appBundleURL: "file:///data/ReviewMe.app/",
    }
    const device = {
      udid: "BBBB-2222",
      name: "Broken iPhone",
      osName: "iOS 26.4",
      isBooted: false,
      isRuntimeAvailable: false,
    }

    await expect(launchBuild(runner, build, device)).rejects.toThrow(
      new RuntimeUnavailable(device)
    )
    expect(runner.executedCommands).toEqual([])
  })
})

describe("The Device Host's versions", () => {
  let runner: FakeSubprocessRunner

  beforeEach(() => {
    runner = new FakeSubprocessRunner()
  })

  /** An Xcode.app layout whose version.plist sits beside Contents/Developer. */
  function writeXcode(plist?: string): string {
    const developer = join(
      mkdtempSync(join(tmpdir(), "nitpick-xcode-")),
      "Xcode.app",
      "Contents",
      "Developer"
    )
    mkdirSync(developer, { recursive: true })
    if (plist !== undefined) {
      writeFileSync(join(developer, "..", "version.plist"), plist)
    }
    return developer
  }

  test("xcodeVersion reads version.plist beside the active developer directory", async () => {
    const developer = writeXcode(
      plistXML({
        CFBundleShortVersionString: "26.1",
        CFBundleVersion: "24000.1.2",
        ProductBuildVersion: "17B55",
      })
    )
    runner.enqueue({ exitCode: 0, standardOutput: `${developer}\n` })

    expect(await xcodeVersion(runner)).toBe("26.1 (17B55)")
    expect(runner.executedCommands).toEqual([xcodeSelect])
  })

  test("xcodeVersion is nil without a readable version.plist or an active developer directory", async () => {
    runner.enqueue({ exitCode: 0, standardOutput: `${writeXcode()}\n` })
    expect(await xcodeVersion(runner)).toBeUndefined()

    runner.enqueue({ exitCode: 2, standardError: "xcode-select: error" })
    expect(await xcodeVersion(runner)).toBeUndefined()
  })

  // Not a port: Swift read ProcessInfo's string in-process.
  test("macOSVersion words sw_vers as ProcessInfo did, and is absent when it fails", async () => {
    runner.enqueue({ exitCode: 0, standardOutput: "26.1\n" })
    runner.enqueue({ exitCode: 0, standardOutput: "25B78\n" })
    expect(await macOSVersion(runner)).toBe("Version 26.1 (Build 25B78)")
    expect(runner.executedCommands).toEqual([
      { executablePath: "/usr/bin/sw_vers", arguments: ["-productVersion"] },
      { executablePath: "/usr/bin/sw_vers", arguments: ["-buildVersion"] },
    ])

    runner.enqueue({ exitCode: 1, standardError: "sw_vers: failed" })
    expect(await macOSVersion(runner)).toBeUndefined()
  })
})
