// The Reviewer's most recently reviewed devices, ported from
// Sources/NitpickCore/RecentDevices.swift: the source of the device picker's
// Recent section and of the preselection. It stores only UDIDs and is
// recorded on a successful launch only, so a stray selection or a reverted
// switch never enters Recent.

/** The device facts Recent reads; the server's SimulatorDevice has them. */
export interface RecentDeviceCandidate {
  readonly udid: string
  readonly isRuntimeAvailable: boolean
}

export class RecentDevices {
  /** How many devices Recent keeps; older entries age out. */
  static readonly capacity = 3

  /** Most recent first, deduplicated, at most `capacity`. */
  readonly udids: ReadonlyArray<string>

  /**
   * Loads a stored list, enforcing the invariants at the boundary, so
   * untrusted stored data can never widen the list past `capacity`.
   */
  constructor(udids: ReadonlyArray<string> = []) {
    this.udids = [...new Set(udids)].slice(0, RecentDevices.capacity)
  }

  /** A launch on `udid`: it moves to the front, and the list stays capped. */
  record(udid: string): RecentDevices {
    return new RecentDevices([
      udid,
      ...this.udids.filter((other) => other !== udid),
    ])
  }

  /**
   * The Recent devices to offer, most recent first: the stored UDIDs that are
   * present in `available` with their runtime installed. Recent only offers
   * devices the Reviewer can launch.
   */
  resolved<Device extends RecentDeviceCandidate>(
    available: ReadonlyArray<Device>
  ): Device[] {
    return this.udids.flatMap((udid) => {
      const device = available.find(
        (candidate) => candidate.udid === udid && candidate.isRuntimeAvailable
      )
      return device === undefined ? [] : [device]
    })
  }

  /**
   * The device to preselect: the most recent one still available, else the
   * first runtime-available device. Never a runtime-missing device.
   */
  preferredDevice<Device extends RecentDeviceCandidate>(
    available: ReadonlyArray<Device>
  ): Device | undefined {
    return (
      this.resolved(available)[0] ??
      available.find((device) => device.isRuntimeAvailable)
    )
  }
}
