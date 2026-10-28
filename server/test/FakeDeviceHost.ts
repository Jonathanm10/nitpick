import { defaultDeviceSettings, type Build } from "@nitpick/core"
import type {
  DeviceHost,
  HostHealth,
  HostVersions,
  ScreenCapture,
  SimulatorDevice,
} from "../src/device/DeviceHost.ts"
import { DeviceNotRunning } from "../src/device/simctl.ts"

/** Records launches and serves scripted captures instead of running simctl. */
export class FakeDeviceHost implements DeviceHost {
  readonly id = "fake"
  readonly label = "Fake host"
  health: HostHealth
  launchFailure: Error | undefined
  readonly launches: { build: Build; device: SimulatorDevice }[] = []
  /** What the next capture returns; a booted device's capture by default. */
  nextCapture: Omit<ScreenCapture, "device"> = {
    png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    settings: defaultDeviceSettings,
  }
  /** Stands in for the capture's simctl calls, which may take a while. */
  captureDelay: Promise<void> = Promise.resolve()

  hostVersions: HostVersions = {
    macOS: "Version 26.1 (Build 25B78)",
    xcode: "26.1 (17B55)",
  }

  constructor(devices: SimulatorDevice[]) {
    this.health = { status: "ready", devices }
  }

  readonly devices = {
    list: async () =>
      this.health.status === "ready" ? this.health.devices : [],
  }

  checkHealth = async () => this.health

  /** Boots the device, as simctl would, even when the launch then fails. */
  launchBuild = async (build: Build, device: SimulatorDevice) => {
    this.#setBooted(device.udid, true)
    if (this.launchFailure !== undefined) throw this.launchFailure
    this.launches.push({ build, device })
  }

  readonly shutdowns: string[] = []

  /** Records the shutdown and shows the device shut down from then on. */
  shutDown = async (deviceUDID: string) => {
    this.shutdowns.push(deviceUDID)
    this.#setBooted(deviceUDID, false)
  }

  #setBooted(deviceUDID: string, isBooted: boolean) {
    if (this.health.status !== "ready") return
    this.health = {
      status: "ready",
      devices: this.health.devices.map((device) =>
        device.udid === deviceUDID ? { ...device, isBooted } : device
      ),
    }
  }

  captureScreen = async (deviceUDID: string): Promise<ScreenCapture> => {
    const device = (await this.devices.list()).find(
      (candidate) => candidate.udid === deviceUDID
    )
    if (!device?.isBooted) {
      throw new DeviceNotRunning(device?.name ?? "The device")
    }
    await this.captureDelay
    return { device, ...this.nextCapture }
  }

  versions = async () => this.hostVersions
}
