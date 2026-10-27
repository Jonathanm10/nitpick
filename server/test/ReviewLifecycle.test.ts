// Ports Tests/NitpickCoreTests/ReviewLifecycleTests.swift. Nobody sits at the
// Device Host, so the launch no longer brings Simulator.app or DeviceHub.app
// forward (parity.md: dropped). The sequence loses its `xcode-select -p` and
// `open -a` steps, and the host-app cases have no counterpart; the same goes
// for SimulatorHostAppTests.swift, whose discovery existed only to open it.
import type { Build } from "@nitpick/core"
import { beforeEach, describe, expect, test } from "vitest"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import { launchBuild } from "../src/device/simctl.ts"
import { SubprocessFailure, type SubprocessCommand } from "../src/subprocess.ts"
import { FakeSubprocessRunner } from "./FakeSubprocessRunner.ts"

const build: Build = {
  identity: {
    bundleID: "ch.liip.reviewme",
    version: "2.1.0",
    buildNumber: "421",
  },
  appBundleURL: "file:///data/reviewers/interim/builds/b1/Review%20Me.app/",
}

const device: SimulatorDevice = {
  udid: "AAAA-1111",
  name: "iPhone 17 Pro",
  osName: "iOS 26.4",
  isBooted: false,
  isRuntimeAvailable: true,
}

const xcrun = (...simctl: string[]): SubprocessCommand => ({
  executablePath: "/usr/bin/xcrun",
  arguments: ["simctl", ...simctl],
})

const expectedSequence: SubprocessCommand[] = [
  xcrun("boot", "AAAA-1111"),
  xcrun("bootstatus", "AAAA-1111", "-b"),
  xcrun(
    "install",
    "AAAA-1111",
    "/data/reviewers/interim/builds/b1/Review Me.app"
  ),
  xcrun("launch", "AAAA-1111", "ch.liip.reviewme"),
]

describe("Launching a Build on a simulator", () => {
  let runner: FakeSubprocessRunner

  beforeEach(() => {
    runner = new FakeSubprocessRunner()
  })

  test("boots, waits for boot, installs, launches — in that order, and never opens a host app", async () => {
    for (let step = 0; step < 4; step++) runner.enqueue({ exitCode: 0 })

    await launchBuild(runner, build, device)

    expect(runner.executedCommands).toEqual(expectedSequence)
  })

  test("an already-booted device is not an error", async () => {
    runner.enqueue({
      exitCode: 149,
      standardError: "Unable to boot device in current state: Booted",
    })
    for (let step = 0; step < 3; step++) runner.enqueue({ exitCode: 0 })

    await launchBuild(runner, build, device)

    expect(runner.executedCommands).toEqual(expectedSequence)
  })

  test("a real boot failure stops the sequence", async () => {
    runner.enqueue({ exitCode: 1, standardError: "Invalid device: AAAA-1111" })

    await expect(launchBuild(runner, build, device)).rejects.toThrow(
      SubprocessFailure
    )
    expect(runner.executedCommands).toEqual(expectedSequence.slice(0, 1))
  })

  test("an install failure surfaces and stops before launch", async () => {
    for (let step = 0; step < 2; step++) runner.enqueue({ exitCode: 0 })
    runner.enqueue({ exitCode: 22, standardError: "Failed to install" })

    await expect(launchBuild(runner, build, device)).rejects.toThrow(
      /Failed to install/
    )
    expect(runner.executedCommands).toEqual(expectedSequence.slice(0, 3))
  })
})
