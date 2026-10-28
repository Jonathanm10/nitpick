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
  type AndroidSDK,
} from "./android.ts"
import type { DeviceHost, SimulatorDevice } from "./DeviceHost.ts"
import {
  AndroidUnavailable,
  checkHostHealth,
  macOSVersion,
  xcodeVersion,
} from "./hostHealth.ts"
import { captureScreen, launchBuild, listSimulatorDevices } from "./simctl.ts"

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
}

/**
 * The machine the server runs on, the only Device Host for now: its iOS
 * simulators through simctl, and its Android emulators through adb and the
 * emulator. iOS needs Xcode, so a host without it isn't ready at all; a host
 * without what Android needs still reviews iOS, and says why it lists no
 * emulator.
 */
export function makeLocalDeviceHost({
  runner,
  starter,
  captureDirectory,
  android,
  ffmpeg,
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
      return androidHealth.status === "ready"
        ? {
            status: "ready",
            devices: [...ios.devices, ...androidHealth.devices],
          }
        : {
            status: "ready",
            devices: ios.devices,
            androidProblem: androidHealth.problem,
          }
    },
    launchBuild: async (build, device) => {
      if (device.platform !== "android") {
        await launchBuild(runner, build, device)
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
    versions: async () => ({
      macOS: await macOSVersion(runner),
      xcode: await xcodeVersion(runner),
    }),
  }
}
