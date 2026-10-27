import type { SubprocessRunner } from "../subprocess.ts"
import type { DeviceHost } from "./DeviceHost.ts"
import { checkHostHealth } from "./hostHealth.ts"
import { launchBuild, listSimulatorDevices } from "./simctl.ts"

/** The machine the server runs on, the only Device Host for now. */
export function makeLocalDeviceHost(runner: SubprocessRunner): DeviceHost {
  return {
    id: "local",
    label: "This machine",
    devices: {
      list: () => listSimulatorDevices(runner),
    },
    checkHealth: () => checkHostHealth(runner),
    launchBuild: (build, device) => launchBuild(runner, build, device),
  }
}
