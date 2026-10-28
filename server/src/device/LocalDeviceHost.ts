import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { newUUID } from "@nitpick/core"
import type { SubprocessRunner } from "../subprocess.ts"
import type { DeviceHost } from "./DeviceHost.ts"
import { checkHostHealth, macOSVersion, xcodeVersion } from "./hostHealth.ts"
import { captureScreen, launchBuild, listSimulatorDevices } from "./simctl.ts"

/**
 * The machine the server runs on, the only Device Host for now. Captures
 * land in `captureDirectory` under a name of their own, so two Reviewers
 * capturing at once never share a file.
 */
export function makeLocalDeviceHost(
  runner: SubprocessRunner,
  captureDirectory: string
): DeviceHost {
  return {
    id: "local",
    label: "This machine",
    devices: {
      list: () => listSimulatorDevices(runner),
    },
    checkHealth: () => checkHostHealth(runner),
    launchBuild: (build, device) => launchBuild(runner, build, device),
    captureScreen: async (deviceUDID) => {
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
