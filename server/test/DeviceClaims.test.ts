// Not a port: the Swift app ran one Reviewer's devices on their own Mac.
// PRD answer 4's cap on booted devices, and one device per Reviewer, as
// DeviceClaims decides them before a launch. All names are fictional.
import { describe, expect, test } from "vitest"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import {
  claimIdleAfter,
  DeviceClaims,
  DeviceHostFull,
  DeviceInUse,
} from "../src/device/deviceClaims.ts"

const vera = { login: "vera", fullName: "Vera Baumann" }
const noor = { login: "noor", fullName: "Noor Haddad" }
const timo = { login: "timo", fullName: "Timo Keller" }

function device(udid: string, isBooted = false): SimulatorDevice {
  return {
    udid,
    name: `iPhone ${udid}`,
    osName: "iOS 26.2",
    isBooted,
    isRuntimeAvailable: true,
  }
}

function claims(limit: number | undefined) {
  let now = 0
  const shutdowns: string[] = []
  const claims = new DeviceClaims({
    limit,
    shutDown: async (udid) => {
      shutdowns.push(udid)
    },
    now: () => now,
  })
  return {
    claims,
    shutdowns,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
  }
}

describe("Without a cap", () => {
  test("a start never shuts anything down", async () => {
    const { claims: c, shutdowns } = claims(undefined)

    await c.claim(vera, device("A"), [device("A"), device("B", true)])
    await c.claim(noor, device("C"), [device("A", true), device("B", true)])

    expect(shutdowns).toEqual([])
  })

  test("a device another Reviewer is using is still refused", async () => {
    const { claims: c } = claims(undefined)
    await c.claim(vera, device("A"), [device("A")])

    await expect(
      c.claim(noor, device("A", true), [device("A", true)])
    ).rejects.toThrow(new DeviceInUse(device("A"), vera).message)
    expect(new DeviceInUse(device("A"), vera).message).toBe(
      "Vera Baumann is reviewing on iPhone A. Pick another device."
    )
  })
})

describe("With a cap of 1", () => {
  test("a start shuts down a booted device nobody is reviewing on", async () => {
    const { claims: c, shutdowns } = claims(1)

    await c.claim(vera, device("A"), [device("A"), device("B", true)])

    expect(shutdowns).toEqual(["B"])
  })

  test("a start while another Reviewer reviews is refused with their name, and nothing shuts down", async () => {
    const { claims: c, shutdowns } = claims(1)
    await c.claim(noor, device("B"), [device("B")])

    const start = c.claim(vera, device("A"), [device("A"), device("B", true)])

    await expect(start).rejects.toThrow(DeviceHostFull)
    await expect(start).rejects.toThrow(
      "The Device Host is full: Noor Haddad is using its only device. Try again once a review there ends."
    )
    expect(shutdowns).toEqual([])
  })

  test("another Reviewer's device counts while it boots, before the list shows it booted", async () => {
    const { claims: c } = claims(1)
    await c.claim(noor, device("B"), [device("A"), device("B")])

    await expect(
      c.claim(vera, device("A"), [device("A"), device("B")])
    ).rejects.toThrow(DeviceHostFull)
  })

  test("two starts at once can't both take the last room", async () => {
    // Each start must first shut down C, which takes a while.
    const c = new DeviceClaims({
      limit: 1,
      shutDown: () => new Promise((resolve) => setTimeout(resolve, 5)),
    })
    const devices = [device("A"), device("B"), device("C", true)]

    const outcomes = await Promise.allSettled([
      c.claim(vera, device("A"), devices),
      c.claim(noor, device("B"), devices),
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
    ])
  })

  test("resuming on the Reviewer's own booted device needs no room", async () => {
    const { claims: c, shutdowns } = claims(1)
    await c.claim(vera, device("A"), [device("A")])

    await c.claim(vera, device("A", true), [device("A", true)])

    expect(shutdowns).toEqual([])
  })

  test("a switch shuts the Reviewer's previous device down for the new one", async () => {
    const { claims: c, shutdowns } = claims(1)
    await c.claim(vera, device("A"), [device("A")])

    await c.claim(vera, device("B"), [device("A", true), device("B")])

    expect(shutdowns).toEqual(["A"])
  })

  test("a released device is free for the next Reviewer", async () => {
    const { claims: c, shutdowns } = claims(1)
    await c.claim(vera, device("A"), [device("A")])

    c.release(vera.login)
    await c.claim(noor, device("B"), [device("A", true), device("B")])

    expect(shutdowns).toEqual(["A"])
  })

  test("a Reviewer silent for the idle time gives their device up; a request keeps it", async () => {
    const { claims: c, shutdowns, advance } = claims(1)
    await c.claim(vera, device("A"), [device("A")])
    const booted = [device("A", true), device("B")]

    advance(claimIdleAfter - 1)
    c.seen(vera.login)
    advance(claimIdleAfter - 1)
    await expect(c.claim(noor, device("B"), booted)).rejects.toThrow(
      DeviceHostFull
    )

    advance(1)
    await c.claim(noor, device("B"), booted)
    expect(shutdowns).toEqual(["A"])
  })

  test("a device shut down for room is nobody's any more", async () => {
    const { claims: c, advance } = claims(1)
    await c.claim(vera, device("A"), [device("A")])
    advance(claimIdleAfter)
    await c.claim(noor, device("B"), [device("A", true), device("B")])

    // Vera comes back to A; Noor's B is what stands in the way, not A.
    await expect(
      c.claim(vera, device("A"), [device("A"), device("B", true)])
    ).rejects.toThrow("Noor Haddad is using its only device")
  })
})

describe("With a cap of 2", () => {
  test("the refusal names everyone using the host", async () => {
    const { claims: c } = claims(2)
    await c.claim(noor, device("B"), [device("B")])
    await c.claim(timo, device("C"), [device("B", true), device("C")])

    await expect(
      c.claim(vera, device("A"), [
        device("A"),
        device("B", true),
        device("C", true),
      ])
    ).rejects.toThrow(
      "The Device Host is full: Noor Haddad and Timo Keller are using its 2 devices. Try again once a review there ends."
    )
  })

  test("only as many unused devices shut down as the start needs", async () => {
    const { claims: c, shutdowns } = claims(2)

    await c.claim(vera, device("A"), [
      device("A"),
      device("B", true),
      device("C", true),
    ])

    expect(shutdowns).toHaveLength(1)
  })
})
