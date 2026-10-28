// Which Reviewer each device on the Device Host runs for, and the host's cap
// on booted devices (PRD answer 4: 1 on the 8 GB host, 2 on the 16 GB one).
// A Reviewer runs on one device at a time, and a device runs for one
// Reviewer. A start that would boot one device too many first shuts down the
// booted devices nobody is using; when that isn't enough, the refusal names
// who is, and the Reviewer tries again later. There is no queue.
//
// Claims live in memory: a restart forgets them, and a device booted before
// it counts as unused until its Reviewer starts or resumes again.
import type { SimulatorDevice } from "./DeviceHost.ts"

/** A Reviewer as a claim names them. */
export interface Claimant {
  readonly login: string
  readonly fullName: string
}

/**
 * How long a Reviewer's device stays theirs after their last request. A
 * visible page asks every 10 s; a tab left hidden this long, or closed,
 * gives its device up to the next Reviewer who needs room.
 */
export const claimIdleAfter = 30 * 60 * 1000

/** Another Reviewer is running a Build on the device. */
export class DeviceInUse extends Error {
  constructor(device: SimulatorDevice, holder: Claimant) {
    super(
      `${holder.fullName} is reviewing on ${device.name}. Pick another device.`
    )
    this.name = "DeviceInUse"
  }
}

/** Booting one more device would pass the host's cap. */
export class DeviceHostFull extends Error {
  constructor(holders: ReadonlyArray<Claimant>, limit: number) {
    const names = holders.map((holder) => holder.fullName)
    const who =
      names.length <= 1
        ? `${names[0] ?? "Another Reviewer"} is`
        : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are`
    const devices = limit === 1 ? "its only device" : `its ${limit} devices`
    super(
      `The Device Host is full: ${who} using ${devices}. Try again once a review there ends.`
    )
    this.name = "DeviceHostFull"
  }
}

interface Claim {
  readonly udid: string
  readonly claimant: Claimant
  lastSeen: number
}

export class DeviceClaims {
  /** At most this many booted devices; undefined for no cap. */
  readonly limit: number | undefined
  readonly #list: () => Promise<ReadonlyArray<SimulatorDevice>>
  readonly #shutDown: (deviceUDID: string) => Promise<void>
  readonly #now: () => number
  /** By login: one device per Reviewer. */
  readonly #claims = new Map<string, Claim>()
  /**
   * Claims and rollbacks decide one at a time, each on the host's list as
   * it is then, so two starts can't both take the last room.
   */
  #turn: Promise<unknown> = Promise.resolve()

  constructor(options: {
    readonly limit: number | undefined
    /** The host's devices as they are now. */
    readonly list: () => Promise<ReadonlyArray<SimulatorDevice>>
    readonly shutDown: (deviceUDID: string) => Promise<void>
    readonly now?: () => number
  }) {
    this.limit = options.limit
    this.#list = options.list
    this.#shutDown = options.shutDown
    this.#now = options.now ?? Date.now
  }

  /** The Reviewer made a request: their device stays theirs. */
  seen(login: string): void {
    const claim = this.#claims.get(login)
    if (claim !== undefined) claim.lastSeen = this.#now()
  }

  /**
   * Makes `device` the claimant's, before its Build launches: refuses a
   * device another Reviewer is using, and makes room under the cap by
   * shutting down unused booted devices. The claimant's previous device
   * becomes unused. Answers the rollback for a launch that fails: the new
   * device is free again, and the claimant keeps their previous one if it
   * still runs and nobody took it meanwhile.
   */
  claim(
    claimant: Claimant,
    device: SimulatorDevice
  ): Promise<() => Promise<void>> {
    return this.#inTurn(() => this.#claim(claimant, device))
  }

  /** The Reviewer's review ended: their device is free for others. */
  release(login: string): void {
    this.#claims.delete(login)
  }

  #inTurn<T>(decide: () => Promise<T>): Promise<T> {
    const decided = this.#turn.then(decide)
    this.#turn = decided.catch(() => {})
    return decided
  }

  async #claim(
    claimant: Claimant,
    device: SimulatorDevice
  ): Promise<() => Promise<void>> {
    const now = this.#now()
    const others = [...this.#claims.values()].filter(
      (claim) =>
        claim.claimant.login !== claimant.login &&
        now - claim.lastSeen < claimIdleAfter
    )
    const holder = others.find((claim) => claim.udid === device.udid)
    if (holder !== undefined) throw new DeviceInUse(device, holder.claimant)

    if (this.limit !== undefined) {
      const held = new Set(others.map((claim) => claim.udid))
      const booted = (await this.#list())
        .filter((each) => each.isBooted)
        .map((each) => each.udid)
      // Others' devices count while they boot too, before the list shows it.
      const occupied = new Set([...held, ...booted, device.udid])
      const previous = this.#claims.get(claimant.login)?.udid
      const unused = [...occupied]
        .filter((udid) => !held.has(udid) && udid !== device.udid)
        // The claimant's own previous device goes first.
        .sort((a, b) => Number(b === previous) - Number(a === previous))
      for (const udid of unused) {
        if (occupied.size <= this.limit) break
        await this.#shutDown(udid)
        occupied.delete(udid)
        this.#dropClaimsOn(udid)
      }
      if (occupied.size > this.limit) {
        throw new DeviceHostFull(
          others.map((claim) => claim.claimant),
          this.limit
        )
      }
    }
    const kept = this.#claims.get(claimant.login)
    // A device changes hands only once its holder went idle; their claim
    // goes with it, or their next request would revive it.
    this.#dropClaimsOn(device.udid)
    const claim = { udid: device.udid, claimant, lastSeen: now }
    this.#claims.set(claimant.login, claim)
    return () =>
      this.#inTurn(async () => {
        if (this.#claims.get(claimant.login) !== claim) return
        this.#claims.delete(claimant.login)
        if (kept === undefined) return
        const taken = [...this.#claims.values()].some(
          (other) => other.udid === kept.udid
        )
        const running = (await this.#list()).some(
          (each) => each.udid === kept.udid && each.isBooted
        )
        if (running && !taken) this.#claims.set(claimant.login, kept)
      })
  }

  /** A device shut down for room, or taken over, is nobody else's. */
  #dropClaimsOn(udid: string): void {
    for (const [login, claim] of this.#claims) {
      if (claim.udid === udid) this.#claims.delete(login)
    }
  }
}
