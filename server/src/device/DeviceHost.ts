// Everything that depends on the machine running the devices sits behind this
// seam (ADR-0012). Modelled on T3 Code's apps/server/src/device/DeviceHost.ts
// (MIT); for now it only lists devices, and later issues add boot, install,
// launch and capture as typed actions.

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
}
