// Everything that depends on the machine running the devices sits behind this
// seam (ADR-0012). Modelled on T3 Code's apps/server/src/device/DeviceHost.ts
// (MIT). Every effect is a typed action with an argument array.
// Types only: api.ts re-exports from here, and web/ must not reach Node code.
import type { Build, DeviceSettings } from "@nitpick/core"

/** A simulator a Build can be reviewed on: the device half of a Device Context. */
export interface SimulatorDevice {
  readonly udid: string
  readonly name: string
  /** Human-readable OS, e.g. "iOS 26.4". */
  readonly osName: string
  readonly isBooted: boolean
  /**
   * False when CoreSimulator can't run this device, typically because its OS
   * runtime was deleted or never downloaded.
   */
  readonly isRuntimeAvailable: boolean
}

/** Discovery for the devices a host can run. */
export interface DeviceOperations {
  /** iOS devices, newest OS first, then by name. */
  readonly list: () => Promise<ReadonlyArray<SimulatorDevice>>
}

export interface DeviceHost {
  readonly id: string
  /** The name the page and errors show for this host. */
  readonly label: string
  readonly devices: DeviceOperations
  /** Whether the host can run a review, with its devices when it can. */
  readonly checkHealth: () => Promise<HostHealth>
  /** Boots `device`, installs the Build and launches it. */
  readonly launchBuild: (build: Build, device: SimulatorDevice) => Promise<void>
  /** Shuts the device down; one already shut down is no error. */
  readonly shutDown: (deviceUDID: string) => Promise<void>
  /**
   * The booted device's screen at native pixels with the accessibility
   * state it was taken under. Refuses a device that isn't booted.
   */
  readonly captureScreen: (deviceUDID: string) => Promise<ScreenCapture>
  /** The host's macOS and Xcode, for a Feedback's Environment. */
  readonly versions: () => Promise<HostVersions>
}

/** What the host could tell of itself; a value it couldn't read is absent. */
export interface HostVersions {
  /** "Version 26.1 (Build 25B78)" */
  readonly macOS?: string
  /** "26.1 (17B55)" */
  readonly xcode?: string
}

/** One capture: the device as it is now, its screenshot and its settings. */
export interface ScreenCapture {
  readonly device: SimulatorDevice
  readonly png: Uint8Array
  readonly settings: DeviceSettings
}

/** What the Device Host is missing before a review can run (ADR-0002). */
export type HostProblem =
  /** No active developer directory: Xcode isn't installed. */
  | { readonly kind: "xcodeNotInstalled" }
  /**
   * The active developer directory is the Command Line Tools, or some other
   * non-Xcode path, which ships no simulators.
   */
  | {
      readonly kind: "commandLineToolsOnly"
      readonly developerDirectory: string
    }
  /**
   * A full Xcode is selected, but its simulator tools don't answer: first
   * launch never finished, the license is unaccepted, or Xcode is gone.
   */
  | { readonly kind: "xcodeSetupIncomplete" }
  /** The tools work, but no iOS simulator device has an installed runtime. */
  | { readonly kind: "missingIOSRuntime" }

export type HostHealth =
  | { readonly status: "ready"; readonly devices: SimulatorDevice[] }
  | { readonly status: "notReady"; readonly problem: HostProblem }
