// Not a port: the Swift app ran one Reviewer's devices on their own Mac.
// PRD answer 4's cap on booted devices, and one device per Reviewer, as
// DeviceClaims decides them before a launch, on a host whose list shows what
// each launch booted and each claim shut down. All names are fictional.
import { describe, expect, test } from "vitest"
import type { SimulatorDevice } from "../src/device/DeviceHost.ts"
import {
  claimIdleAfter,
  DeviceClaims,
  DeviceHostFull,
  DeviceInUse,
  type Claimant,
} from "../src/device/deviceClaims.ts"

const vera = { login: "vera", fullName: "Vera Baumann" }
const noor = { login: "noor", fullName: "Noor Haddad" }
const timo = { login: "timo", fullName: "Timo Keller" }

function device(udid: string): SimulatorDevice {
  return {
    udid,
    name: `iPhone ${udid}`,
    osName: "iOS 26.2",
    isBooted: false,
    isRuntimeAvailable: true,
  }
}

/** Devices A, B and C; `booted` run already. */
function host(
  limit: number | undefined,
  booted: string[] = [],
  shutDownDelay = 0
) {
  let now = 0
  const running = new Set(booted)
  const shutdowns: string[] = []
  const claims = new DeviceClaims({
    limit,
    list: async () =>
      ["A", "B", "C"].map((udid) => ({
        ...device(udid),
        isBooted: running.has(udid),
      })),
    shutDown: async (udid) => {
      await new Promise((resolve) => setTimeout(resolve, shutDownDelay))
      shutdowns.push(udid)
      running.delete(udid)
    },
    now: () => now,
  })
  return {
    claims,
    shutdowns,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    /** A start: the claim, then a launch that boots the device. */
    async start(claimant: Claimant, udid: string) {
      const rollback = await claims.claim(claimant, device(udid))
      running.add(udid)
      return rollback
    },
  }
}

describe("Without a cap", () => {
  test("a start never shuts anything down", async () => {
    const h = host(undefined, ["B"])

    await h.start(vera, "A")
    await h.start(noor, "C")

    expect(h.shutdowns).toEqual([])
  })

  test("a device another Reviewer is using is still refused", async () => {
    const h = host(undefined)
    await h.start(vera, "A")

    await expect(h.claims.claim(noor, device("A"))).rejects.toThrow(
      "Vera Baumann is reviewing on iPhone A. Pick another device."
    )
  })
})

describe("With a cap of 1", () => {
  test("a start shuts down a booted device nobody is reviewing on", async () => {
    const h = host(1, ["B"])

    await h.start(vera, "A")

    expect(h.shutdowns).toEqual(["B"])
  })

  test("a start while another Reviewer reviews is refused with their name, and nothing shuts down", async () => {
    const h = host(1)
    await h.start(noor, "B")

    const start = h.claims.claim(vera, device("A"))

    await expect(start).rejects.toThrow(DeviceHostFull)
    await expect(start).rejects.toThrow(
      "The Device Host is full: Noor Haddad is using its only device. Try again once a review there ends."
    )
    expect(h.shutdowns).toEqual([])
  })

  test("another Reviewer's device counts while it boots, before the list shows it booted", async () => {
    const h = host(1)
    await h.claims.claim(noor, device("B"))

    await expect(h.claims.claim(vera, device("A"))).rejects.toThrow(
      DeviceHostFull
    )
  })

  test("two starts at once can't both take the last room", async () => {
    // Each start must first shut down C, which takes a while.
    const h = host(1, ["C"], 5)

    const outcomes = await Promise.allSettled([
      h.claims.claim(vera, device("A")),
      h.claims.claim(noor, device("B")),
    ])

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
    ])
    expect(h.shutdowns).toEqual(["C"])
  })

  test("resuming on the Reviewer's own booted device needs no room", async () => {
    const h = host(1)
    await h.start(vera, "A")

    await h.start(vera, "A")

    expect(h.shutdowns).toEqual([])
  })

  test("a switch shuts the Reviewer's previous device down for the new one", async () => {
    const h = host(1)
    await h.start(vera, "A")

    await h.start(vera, "B")

    expect(h.shutdowns).toEqual(["A"])
  })

  test("a released device is free for the next Reviewer", async () => {
    const h = host(1)
    await h.start(vera, "A")

    h.claims.release(vera.login)
    await h.start(noor, "B")

    expect(h.shutdowns).toEqual(["A"])
  })

  test("a Reviewer silent for the idle time gives their device up; a request keeps it", async () => {
    const h = host(1)
    await h.start(vera, "A")

    h.advance(claimIdleAfter - 1)
    h.claims.seen(vera.login)
    h.advance(claimIdleAfter - 1)
    await expect(h.claims.claim(noor, device("B"))).rejects.toThrow(
      DeviceHostFull
    )

    h.advance(1)
    await h.start(noor, "B")
    expect(h.shutdowns).toEqual(["A"])
  })

  test("a device shut down for room is nobody's any more", async () => {
    const h = host(1)
    await h.start(vera, "A")
    h.advance(claimIdleAfter)
    await h.start(noor, "B")

    // Vera comes back to A; Noor's B is what stands in the way, not A.
    await expect(h.claims.claim(vera, device("A"))).rejects.toThrow(
      "Noor Haddad is using its only device"
    )
  })

  test("a device taken over from an idle Reviewer stays its new Reviewer's when the old one comes back", async () => {
    const h = host(1)
    await h.start(vera, "A")
    h.advance(claimIdleAfter)
    await h.start(noor, "A")

    h.claims.seen(vera.login)

    await h.start(noor, "B")
    expect(h.shutdowns).toEqual(["A"])
  })
})

describe("A launch that fails", () => {
  test("frees its device, which counts as nobody's while it still runs", async () => {
    const h = host(1)
    // The launch booted A, then the install failed.
    const rollback = await h.start(vera, "A")

    await rollback()

    await h.start(noor, "B")
    expect(h.shutdowns).toEqual(["A"])
  })

  test("on a switch, keeps the Reviewer's previous device theirs", async () => {
    const h = host(undefined)
    await h.start(vera, "A")
    const rollback = await h.claims.claim(vera, device("B"))

    await rollback()

    await expect(h.claims.claim(noor, device("A"))).rejects.toThrow(DeviceInUse)
    await h.start(noor, "B")
  })

  test("on a switch, doesn't take back a previous device another Reviewer took meanwhile", async () => {
    const h = host(2)
    await h.start(vera, "A")
    const rollback = await h.claims.claim(vera, device("B"))
    await h.start(noor, "A")

    await rollback()

    await h.start(noor, "A")
  })

  test("on a switch, doesn't take back a previous device that stopped meanwhile", async () => {
    const h = host(2)
    await h.start(vera, "A")
    const rollback = await h.claims.claim(vera, device("B"))
    // Noor's start shuts A down for room while B's launch runs.
    await h.start(noor, "C")
    expect(h.shutdowns).toEqual(["A"])

    await rollback()

    await h.claims.claim(timo, device("B"))
  })
})

describe("With a cap of 2", () => {
  test("the refusal names everyone using the host", async () => {
    const h = host(2)
    await h.start(noor, "B")
    await h.start(timo, "C")

    await expect(h.claims.claim(vera, device("A"))).rejects.toThrow(
      "The Device Host is full: Noor Haddad and Timo Keller are using its 2 devices. Try again once a review there ends."
    )
  })

  test("only as many unused devices shut down as the start needs", async () => {
    const h = host(2, ["B", "C"])

    await h.start(vera, "A")

    expect(h.shutdowns).toHaveLength(1)
  })
})
