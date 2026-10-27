// Ports Tests/NitpickCoreTests/CaptureTests.swift: the device is checked for
// booted, then the screenshot and the three accessibility reads run at once,
// and their failures surface in a fixed order.
//
// Changed in the port: the device is passed by udid and comes back as the
// live list has it; the capture file is the caller's path, removed once read;
// the unreadable-capture message no longer names a server path.
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  CaptureUnreadable,
  captureScreen,
  DeviceNotRunning,
} from "../src/device/simctl.ts"
import {
  SubprocessFailure,
  type SubprocessCommand,
  type SubprocessResult,
  type SubprocessRunner,
} from "../src/subprocess.ts"
import { temporaryDirectory } from "./BuildFixtures.ts"

const udid = "AAAA-1111"
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
])

function deviceListJSON(state: string): string {
  return JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-4": [
        { udid, name: "iPhone 17 Pro", state, isAvailable: true },
      ],
    },
  })
}

const settingsValues: Record<string, string> = {
  content_size: "accessibility-large",
  appearance: "dark",
  increase_contrast: "enabled",
}

type Reply = (command: SubprocessCommand) => Promise<SubprocessResult>

function result(
  exitCode: number,
  standardOutput = "",
  standardError = ""
): SubprocessResult {
  return {
    exitCode,
    standardOutput: Buffer.from(standardOutput),
    standardError: Buffer.from(standardError),
  }
}

/**
 * Answers each command by what it is, since the screenshot and the reads
 * run concurrently in no fixed order, and records every command started.
 */
class CaptureRunner implements SubprocessRunner {
  readonly started: string[] = []
  deviceState = "Booted"
  screenshot: Reply = async (command) => {
    writeFileSync(command.arguments.at(-1)!, pngBytes)
    return result(0)
  }
  settingsRead: (option: string) => Promise<SubprocessResult> = async (
    option
  ) => result(0, `${settingsValues[option]}\n`)

  async run(command: SubprocessCommand): Promise<SubprocessResult> {
    const [, verb, , action] = command.arguments
    this.started.push(
      verb === "list" ? "list" : verb === "io" ? action : `ui ${action}`
    )
    if (verb === "list") return result(0, deviceListJSON(this.deviceState))
    if (verb === "io") return this.screenshot(command)
    return this.settingsRead(action)
  }
}

function capturePath(): string {
  return join(temporaryDirectory(), "capture.png")
}

async function failure(capture: Promise<unknown>): Promise<unknown> {
  try {
    await capture
  } catch (error) {
    return error
  }
  throw new Error("expected the capture to fail")
}

describe("Capturing the simulator screen", () => {
  test("a capture checks the device is booted, then takes the screenshot and reads the accessibility state", async () => {
    const runner = new CaptureRunner()
    const path = capturePath()

    const captured = await captureScreen(runner, udid, path)

    expect(runner.started[0]).toBe("list")
    expect(runner.started.slice(1).sort()).toEqual([
      "screenshot",
      "ui appearance",
      "ui content_size",
      "ui increase_contrast",
    ])
    expect(Buffer.from(captured.png)).toEqual(pngBytes)
    expect(captured.settings).toEqual({
      dynamicTypeSize: "accessibility-large",
      appearance: "dark",
      increaseContrast: true,
    })
    expect(captured.device).toMatchObject({ udid, name: "iPhone 17 Pro" })
    expect(existsSync(path)).toBe(false)
  })

  test("the screenshot runs simctl io with the png type into the given path", async () => {
    const commands: SubprocessCommand[] = []
    const runner = new CaptureRunner()
    const screenshot = runner.screenshot
    runner.screenshot = async (command) => {
      commands.push(command)
      return screenshot(command)
    }
    const path = capturePath()

    await captureScreen(runner, udid, path)

    expect(commands).toEqual([
      {
        executablePath: "/usr/bin/xcrun",
        arguments: ["simctl", "io", udid, "screenshot", "--type=png", path],
      },
    ])
  })

  test("the screenshot and the three settings reads are all in flight at once", async () => {
    const runner = new CaptureRunner()
    let inFlight = 0
    let maxInFlight = 0
    let release = () => {}
    const allStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const gated =
      <T>(reply: () => Promise<T>) =>
      async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        if (inFlight === 4) release()
        await Promise.race([
          allStarted,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ])
        inFlight -= 1
        return reply()
      }
    const screenshot = runner.screenshot
    const read = runner.settingsRead
    runner.screenshot = (command) => gated(() => screenshot(command))()
    runner.settingsRead = (option) => gated(() => read(option))()

    await captureScreen(runner, udid, capturePath())

    expect(maxInFlight).toBe(4)
    expect(runner.started[0]).toBe("list")
  })

  test("a screenshot failure surfaces as the screenshot's subprocess failure, even when a settings read fails too", async () => {
    const runner = new CaptureRunner()
    runner.screenshot = async () => result(1, "", "No devices are booted.")
    runner.settingsRead = async (option) =>
      option === "content_size"
        ? result(1, "", "content_size failed")
        : result(0, "large\n")

    const error = await failure(captureScreen(runner, udid, capturePath()))

    expect(error).toBeInstanceOf(SubprocessFailure)
    expect((error as SubprocessFailure).command.arguments).toContain(
      "screenshot"
    )
    expect((error as SubprocessFailure).standardError).toBe(
      "No devices are booted."
    )
  })

  test("a screenshot failure surfaces at once while a settings read is stuck", async () => {
    const runner = new CaptureRunner()
    runner.settingsRead = () => new Promise(() => {})
    runner.screenshot = async () => result(1, "", "No devices are booted.")

    const error = await failure(captureScreen(runner, udid, capturePath()))

    expect(error).toBeInstanceOf(SubprocessFailure)
  })

  test("a failed settings read surfaces as that read's failure, the first in content_size, appearance, increase_contrast order", async () => {
    const runner = new CaptureRunner()
    runner.settingsRead = async (option) =>
      option === "content_size"
        ? result(0, "large\n")
        : result(1, "", `${option} failed`)

    const error = await failure(captureScreen(runner, udid, capturePath()))

    expect(error).toBeInstanceOf(SubprocessFailure)
    expect((error as SubprocessFailure).command.arguments).toEqual([
      "simctl",
      "ui",
      udid,
      "appearance",
    ])
  })

  test("unparseable settings read as their defaults, so the Accessibility line carries no raw token", async () => {
    const runner = new CaptureRunner()
    runner.settingsRead = async () => result(0, "unsupported\n")

    const captured = await captureScreen(runner, udid, capturePath())

    expect(captured.settings).toEqual({
      dynamicTypeSize: "large",
      appearance: "light",
      increaseContrast: false,
    })
  })

  test("a screenshot that reports success but writes nothing is a clear error", async () => {
    const runner = new CaptureRunner()
    runner.screenshot = async () => result(0)

    const error = await failure(captureScreen(runner, udid, capturePath()))

    expect(error).toBeInstanceOf(CaptureUnreadable)
    expect((error as Error).message).toBe(
      "The capture succeeded but no image could be read."
    )
  })

  test("a device that is no longer booted refuses fast: the screenshot command that would hang never runs", async () => {
    const runner = new CaptureRunner()
    runner.deviceState = "Shutdown"

    const error = await failure(captureScreen(runner, udid, capturePath()))

    expect(error).toBeInstanceOf(DeviceNotRunning)
    expect((error as Error).message).toBe(
      "iPhone 17 Pro is no longer running on the Device Host, so nothing was captured. Resume review to relaunch the Build."
    )
    expect(runner.started).toEqual(["list"])
  })
})
