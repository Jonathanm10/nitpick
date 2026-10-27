import { readFile, rm } from "node:fs/promises"
import {
  defaultDeviceSettings,
  dynamicTypeSizes,
  type Build,
  type DeviceSettings,
  type DynamicTypeSize,
} from "@nitpick/core"
import { appBundlePath } from "../buildIngestion.ts"
import {
  SubprocessFailure,
  type SubprocessCommand,
  type SubprocessResult,
  type SubprocessRunner,
} from "../subprocess.ts"
import type { ScreenCapture, SimulatorDevice } from "./DeviceHost.ts"

// Typed simctl actions. Each builds a fixed argument array for the subprocess
// seam; nothing here takes a command string. Ported from
// Sources/NitpickCore/Simulator.swift.

export const listDevicesCommand: SubprocessCommand = {
  executablePath: "/usr/bin/xcrun",
  arguments: ["simctl", "list", "devices", "--json"],
}

/** `simctl list` returned output the server cannot parse. */
export class MalformedDeviceList extends Error {
  constructor() {
    super(
      "The simulator device list could not be read. Is Xcode installed correctly?"
    )
    this.name = "MalformedDeviceList"
  }
}

/**
 * The iOS simulator devices simctl knows, newest OS first, then by name.
 * Non-iOS runtimes are dropped; devices whose own runtime is missing stay in
 * the list, flagged, so the picker can say why they can't be chosen.
 */
export async function listSimulatorDevices(
  runner: SubprocessRunner
): Promise<SimulatorDevice[]> {
  const result = await runRequiringSuccess(runner, listDevicesCommand)
  return parseDeviceList(result.standardOutput.toString("utf8"))
}

/** `launchBuild` was asked to boot a device whose OS runtime is missing. */
export class RuntimeUnavailable extends Error {
  constructor(device: SimulatorDevice) {
    super(
      `${device.name} can't be booted: its ${device.osName} simulator runtime isn't installed on the Device Host. Ask whoever runs the Device Host to install it.`
    )
    this.name = "RuntimeUnavailable"
  }
}

/**
 * Boots the device, installs the Build and launches it (ADR-0002). Nobody
 * sits at the Device Host, so no Simulator window is brought forward: the
 * page shows the device. nitpick never touches the device's accessibility
 * state (ADR-0009); it reads it back at capture.
 */
export async function launchBuild(
  runner: SubprocessRunner,
  build: Build,
  device: SimulatorDevice
): Promise<void> {
  // The picker already greys such a device out; refusing here keeps the
  // invariant for a stale selection, with the runtime story instead of an
  // obscure boot error.
  if (!device.isRuntimeAvailable) throw new RuntimeUnavailable(device)

  // Exit 149: "Unable to boot device in current state: Booted". Launching
  // onto a booted device is normal, not a failure.
  await runRequiringSuccess(runner, simctl("boot", device.udid), [0, 149])
  // `simctl boot` returns while the device may still be booting; bootstatus
  // -b blocks until it is usable, and returns at once for a booted device.
  await runRequiringSuccess(runner, simctl("bootstatus", device.udid, "-b"))
  await runRequiringSuccess(
    runner,
    simctl("install", device.udid, appBundlePath(build))
  )
  await runRequiringSuccess(
    runner,
    simctl("launch", device.udid, build.identity.bundleID)
  )
}

/**
 * The device to capture is not booted on the Device Host: it stopped after
 * the launch (a crash, a host reboot), or was never booted. The review pauses.
 */
export class DeviceNotRunning extends Error {
  constructor(deviceName: string) {
    super(
      `${deviceName} is no longer running on the Device Host, so nothing was captured. Resume review to relaunch the Build.`
    )
    this.name = "DeviceNotRunning"
  }
}

/** `simctl io screenshot` reported success but left no readable PNG. */
export class CaptureUnreadable extends Error {
  constructor() {
    super("The capture succeeded but no image could be read.")
    this.name = "CaptureUnreadable"
  }
}

/**
 * Captures the device's screen at native resolution with the simulator's own
 * screenshot, never a stream frame (ADR-0012), together with the
 * accessibility state it was taken under (ADR-0009). `capturePath` is where
 * simctl writes the PNG; it is removed once read.
 *
 * `simctl io screenshot` waits forever for a device that isn't booted, so the
 * live state is checked first, by udid. The screenshot and the settings reads
 * then run at once; errors surface in this order: not booted, the
 * screenshot, then each setting. Ported from Simulator.swift's captureScreen.
 */
export async function captureScreen(
  runner: SubprocessRunner,
  deviceUDID: string,
  capturePath: string
): Promise<ScreenCapture> {
  const devices = await listSimulatorDevices(runner)
  const device = devices.find((candidate) => candidate.udid === deviceUDID)
  if (!device?.isBooted) {
    throw new DeviceNotRunning(device?.name ?? "The device")
  }
  const settings = observedSettings(runner, device)
  // Handled here so a screenshot failure, which surfaces first without
  // waiting for the reads, never leaves an unhandled rejection behind.
  settings.catch(() => {})
  const png = await screenshot(runner, device, capturePath)
  return { device, png, settings: await settings }
}

async function screenshot(
  runner: SubprocessRunner,
  device: SimulatorDevice,
  capturePath: string
): Promise<Buffer> {
  try {
    await runRequiringSuccess(
      runner,
      simctl("io", device.udid, "screenshot", "--type=png", capturePath)
    )
    const png = await readFile(capturePath).catch(() => undefined)
    if (png === undefined || png.length === 0) throw new CaptureUnreadable()
    return png
  } finally {
    await rm(capturePath, { force: true })
  }
}

/**
 * The device's live accessibility state, the settings half of a Device
 * Context. Each `simctl ui <device> <option>` without a value prints the
 * current one. The three reads run at once, and a failure throws the first
 * of them in content_size, appearance, increase_contrast order. A value
 * that can't be parsed reads as that setting's default, so the
 * Accessibility line never carries a raw token.
 */
export async function observedSettings(
  runner: SubprocessRunner,
  device: SimulatorDevice
): Promise<DeviceSettings> {
  const reads = ["content_size", "appearance", "increase_contrast"].map(
    async (option) => {
      const result = await runRequiringSuccess(
        runner,
        simctl("ui", device.udid, option)
      )
      return result.standardOutput.toString("utf8").trim()
    }
  )
  const settled = await Promise.allSettled(reads)
  const failure = settled.find((read) => read.status === "rejected")
  if (failure !== undefined) throw failure.reason
  const [contentSize, appearance, increaseContrast] = settled.map((read) =>
    read.status === "fulfilled" ? read.value : ""
  )
  return {
    dynamicTypeSize: dynamicTypeSizes.includes(contentSize as DynamicTypeSize)
      ? (contentSize as DynamicTypeSize)
      : defaultDeviceSettings.dynamicTypeSize,
    appearance: appearance === "dark" ? "dark" : "light",
    increaseContrast: increaseContrast === "enabled",
  }
}

function simctl(...simctlArguments: string[]): SubprocessCommand {
  return {
    executablePath: "/usr/bin/xcrun",
    arguments: ["simctl", ...simctlArguments],
  }
}

/**
 * Runs a command through the subprocess seam and turns a disallowed exit
 * code into a SubprocessFailure carrying the command and its stderr.
 */
export async function runRequiringSuccess(
  runner: SubprocessRunner,
  command: SubprocessCommand,
  allowedExitCodes: ReadonlyArray<number> = [0]
): Promise<SubprocessResult> {
  const result = await runner.run(command)
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new SubprocessFailure(
      command,
      result.exitCode,
      result.standardError.toString("utf8")
    )
  }
  return result
}

export function parseDeviceList(json: string): SimulatorDevice[] {
  return Object.entries(decodeDeviceList(json))
    .flatMap(([runtimeIdentifier, devices]) => {
      const runtime = parseRuntime(runtimeIdentifier)
      return runtime?.platform === "iOS" ? [{ runtime, devices }] : []
    })
    .sort((lhs, rhs) =>
      compareVersions(rhs.runtime.version, lhs.runtime.version)
    )
    .flatMap(({ runtime, devices }) =>
      [...devices]
        .sort((lhs, rhs) => compareStrings(lhs.name, rhs.name))
        .map((device) => ({
          udid: device.udid,
          name: device.name,
          osName: runtime.osName,
          isBooted: device.state === "Booted",
          isRuntimeAvailable: device.isAvailable ?? true,
        }))
    )
}

/** The subset of `simctl list devices --json` the server reads. */
interface SimctlDevice {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly isAvailable?: boolean | null
}

/**
 * Accepts what Swift's `JSONDecoder` accepts for the same shape: every device
 * needs string `udid`, `name` and `state`; `isAvailable` may be missing or
 * null; anything else is a malformed list.
 */
function decodeDeviceList(json: string): Record<string, SimctlDevice[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new MalformedDeviceList()
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) {
    throw new MalformedDeviceList()
  }
  const devices = parsed.devices
  for (const list of Object.values(devices)) {
    if (!Array.isArray(list) || !list.every(isSimctlDevice)) {
      throw new MalformedDeviceList()
    }
  }
  return devices as Record<string, SimctlDevice[]>
}

function isSimctlDevice(value: unknown): value is SimctlDevice {
  return (
    isRecord(value) &&
    typeof value.udid === "string" &&
    typeof value.name === "string" &&
    typeof value.state === "string" &&
    (value.isAvailable === undefined ||
      value.isAvailable === null ||
      typeof value.isAvailable === "boolean")
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** A parsed CoreSimulator runtime identifier, e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-4`. */
interface SimctlRuntime {
  readonly platform: string
  readonly version: number[]
  readonly osName: string
}

const runtimePrefix = "com.apple.CoreSimulator.SimRuntime."

function parseRuntime(runtimeIdentifier: string): SimctlRuntime | undefined {
  if (!runtimeIdentifier.startsWith(runtimePrefix)) return undefined
  // Swift's split(separator:) drops empty pieces, so this does too.
  const parts = runtimeIdentifier
    .slice(runtimePrefix.length)
    .split("-")
    .filter((part) => part !== "")
  const [platform, ...versionParts] = parts
  if (platform === undefined || versionParts.length === 0) return undefined
  if (!versionParts.every((part) => /^[0-9]+$/.test(part))) return undefined
  return {
    platform,
    version: versionParts.map(Number),
    osName: `${platform} ${versionParts.join(".")}`,
  }
}

/** Lexicographic, like Swift's `lexicographicallyPrecedes` on `[Int]`. */
function compareVersions(lhs: number[], rhs: number[]): number {
  for (let index = 0; index < Math.min(lhs.length, rhs.length); index++) {
    const difference = lhs[index] - rhs[index]
    if (difference !== 0) return difference
  }
  return lhs.length - rhs.length
}

/** Not locale-aware, like the Swift app's `<` on names. */
function compareStrings(lhs: string, rhs: string): number {
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}
