import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { newUUID } from "@nitpick/core"
import { apkPath, readBuildFromAPK } from "../buildIngestion.ts"
import type { ProcessStarter, SubprocessRunner } from "../subprocess.ts"
import {
  aapt2Path,
  bootEmulator,
  captureEmulator,
  checkAndroidHealth,
  hasLibx264,
  installAndLaunch,
  listAndroidDevices,
  shutdownEmulator,
  type AndroidSDK,
} from "./android.ts"
import type { DeviceHost, SimulatorDevice } from "./DeviceHost.ts"
import { freeLoopbackPort } from "./deviceHub.ts"
import {
  AndroidUnavailable,
  checkHostHealth,
  macOSVersion,
  xcodeVersion,
} from "./hostHealth.ts"
import {
  buildInspectLibrary,
  fetchLayout,
  inspectLaunchEnvironment,
  newInspectSecret,
  type InspectEndpoint,
  type InspectLibrary,
} from "./inspect.ts"
import { layoutSnapshot } from "./layoutSnapshot.ts"
import {
  captureScreen,
  DeviceNotRunning,
  launchBuild,
  listSimulatorDevices,
  shutDownDevice,
} from "./simctl.ts"

export interface LocalDeviceHostOptions {
  readonly runner: SubprocessRunner
  /** Boots emulators, which outlive the request. */
  readonly starter: ProcessStarter
  /**
   * Where captures land, each under a name of its own, so two Reviewers
   * capturing at once never share a file.
   */
  readonly captureDirectory: string
  readonly android: AndroidSDK
  /** The ffmpeg the hub streams emulators with, if the host has one. */
  readonly ffmpeg: string | undefined
  /** Where the Inspect library is built and kept. */
  readonly inspectDirectory: string
}

/**
 * The machine the server runs on, the only Device Host for now: its iOS
 * simulators through simctl, and its Android emulators through adb and the
 * emulator. iOS needs Xcode, so a host without it isn't ready at all; a host
 * without what Android needs still reviews iOS, and says why it lists no
 * emulator. One whose Xcode can't build the Inspect library launches iOS
 * Builds without it, and says why.
 */
export function makeLocalDeviceHost({
  runner,
  starter,
  captureDirectory,
  android,
  ffmpeg,
  inspectDirectory,
}: LocalDeviceHostOptions): DeviceHost {
  const listEmulators = () =>
    listAndroidDevices(runner, android).catch((): SimulatorDevice[] => [])
  // ffmpeg doesn't lose libx264 between checks; a missing one is checked
  // again, so installing it needs no restart.
  let ffmpegConfirmed = false
  const ffmpegReady = async () =>
    (ffmpegConfirmed ||=
      ffmpeg !== undefined && (await hasLibx264(runner, ffmpeg)))
  const list = async () => {
    const [simulators, emulators] = await Promise.all([
      listSimulatorDevices(runner),
      listEmulators(),
    ])
    return [...simulators, ...emulators]
  }
  // Built, or found built, once per server start; a host whose Xcode
  // couldn't build it is fixed, then restarted.
  let library: Promise<InspectLibrary> | undefined
  const inspectLibrary = () =>
    (library ??= buildInspectLibrary(runner, inspectDirectory))
  /** Where each simulator's running Build answers Inspect, by UDID. */
  const inspectEndpoints = new Map<string, InspectEndpoint>()
  return {
    id: "local",
    label: "This machine",
    devices: { list },
    checkHealth: async () => {
      const [ios, androidHealth] = await Promise.all([
        checkHostHealth(runner),
        checkAndroidHealth(runner, android, ffmpegReady),
      ])
      if (ios.status === "notReady") return ios
      const built = await inspectLibrary()
      return {
        status: "ready",
        ...(androidHealth.status === "ready"
          ? { devices: [...ios.devices, ...androidHealth.devices] }
          : { devices: ios.devices, androidProblem: androidHealth.problem }),
        ...(built.status === "unbuilt" && { inspectProblem: built.reason }),
      }
    },
    // A new port and secret for every launch, so two simulators, which
    // share the host's loopback, never answer for each other.
    launchBuild: async (build, device) => {
      if (device.platform !== "android") {
        inspectEndpoints.delete(device.udid)
        const built = await inspectLibrary()
        if (built.status === "unbuilt") {
          await launchBuild(runner, build, device)
          return device
        }
        const endpoint = {
          port: await freeLoopbackPort(),
          secret: newInspectSecret(),
        }
        await launchBuild(
          runner,
          build,
          device,
          inspectLaunchEnvironment(built.path, endpoint)
        )
        inspectEndpoints.set(device.udid, endpoint)
        return device
      }
      const serial = await bootEmulator(runner, starter, android, device)
      await installAndLaunch(runner, android, serial, {
        path: apkPath(build),
        packageID: build.identity.bundleID,
      })
      return { ...device, isBooted: true, serial }
    },
    readAndroidBuild: async (apk) => {
      const aapt2 = await aapt2Path(android)
      if (aapt2 === undefined)
        throw new AndroidUnavailable({ kind: "buildToolsMissing" })
      return readBuildFromAPK(runner, aapt2, apk)
    },
    // An emulator is shut down by its serial, which only a running one has.
    shutDown: async (deviceUDID) => {
      const emulator = (await listEmulators()).find(
        (device) => device.udid === deviceUDID
      )
      if (emulator === undefined) return shutDownDevice(runner, deviceUDID)
      if (emulator.serial !== undefined) {
        await shutdownEmulator(runner, android, emulator.serial)
      }
    },
    captureScreen: async (deviceUDID) => {
      const emulators = await listEmulators()
      const emulator = emulators.find((device) => device.udid === deviceUDID)
      if (emulator !== undefined)
        return captureEmulator(runner, android, emulator)
      await mkdir(captureDirectory, { recursive: true })
      return captureScreen(
        runner,
        deviceUDID,
        join(captureDirectory, `${newUUID()}.png`)
      )
    },
    inspectLayout: async (deviceUDID) => {
      // The launch the Reviewer's claim names now, before anything yields: a
      // later launch on the device, another Reviewer's, has its own secret.
      const endpoint = inspectEndpoints.get(deviceUDID)
      const device = (await listSimulatorDevices(runner)).find(
        (candidate) => candidate.udid === deviceUDID
      )
      if (
        device === undefined &&
        (await listEmulators()).some((emulator) => emulator.udid === deviceUDID)
      ) {
        return { status: "unavailable", reason: inspectAndroidReason }
      }
      if (!device?.isBooted) {
        throw new DeviceNotRunning(
          device?.name ?? "The device",
          "it can't be inspected"
        )
      }
      if (endpoint === undefined) {
        const built = await inspectLibrary()
        return {
          status: "unavailable",
          reason:
            built.status === "unbuilt" ? built.reason : launchedWithoutInspect,
        }
      }
      return {
        status: "ready",
        snapshot: layoutSnapshot(await fetchLayout(endpoint)),
      }
    },
    versions: async () => ({
      macOS: await macOSVersion(runner),
      xcode: await xcodeVersion(runner),
    }),
  }
}

const inspectAndroidReason =
  "Inspect reads SwiftUI layouts on iOS simulators, so it isn't available on Android emulators."

const launchedWithoutInspect =
  "This Build was launched without Inspect. Resume review to relaunch it with Inspect."
