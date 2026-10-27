// Ports Tests/NitpickCoreTests/RecentDevicesTests.swift.
import { describe, expect, test } from "vitest"
import { RecentDevices } from "../src/recentDevices.ts"

function device(udid: string, runtimeAvailable = true) {
  return {
    udid,
    name: `Device ${udid}`,
    osName: "iOS 26.4",
    isBooted: false,
    isRuntimeAvailable: runtimeAvailable,
  }
}

describe("Recent devices MRU + preselection", () => {
  test("recording promotes to the front, most-recent first", () => {
    const recent = new RecentDevices().record("A").record("B").record("C")

    expect(recent.udids).toEqual(["C", "B", "A"])
  })

  test("recording an existing UDID de-duplicates and moves it to the front", () => {
    const recent = new RecentDevices(["C", "B", "A"]).record("A")

    expect(recent.udids).toEqual(["A", "C", "B"])
  })

  test("the list is capped at 3, oldest dropped", () => {
    const recent = new RecentDevices()
      .record("A")
      .record("B")
      .record("C")
      .record("D")

    expect(recent.udids).toEqual(["D", "C", "B"])
  })

  test("loading from persistence dedupes and caps at the boundary", () => {
    const recent = new RecentDevices(["A", "B", "A", "C", "D"])

    expect(recent.udids).toEqual(["A", "B", "C"])
  })

  test("Recent lists present, runtime-available devices in MRU order", () => {
    const recent = new RecentDevices(["C", "B", "A"])
    const available = [device("A"), device("C")]

    expect(recent.resolved(available).map((d) => d.udid)).toEqual(["C", "A"])
  })

  test("Recent drops runtime-missing devices", () => {
    const recent = new RecentDevices(["B", "A"])
    const available = [device("A"), device("B", false)]

    expect(recent.resolved(available).map((d) => d.udid)).toEqual(["A"])
  })

  test("preselection returns the most-recent still-available device", () => {
    const recent = new RecentDevices(["B", "A"])
    const available = [device("A"), device("B"), device("C")]

    expect(recent.preferredDevice(available)?.udid).toBe("B")
  })

  test("preselection falls back to the first runtime-available device when the MRU is empty", () => {
    const recent = new RecentDevices()
    const available = [device("A", false), device("B"), device("C")]

    expect(recent.preferredDevice(available)?.udid).toBe("B")
  })

  test("preselection falls back to the first available when the MRU's devices are gone", () => {
    const recent = new RecentDevices(["X", "Y"])
    const available = [device("A"), device("B")]

    expect(recent.preferredDevice(available)?.udid).toBe("A")
  })

  test("preselection never returns a runtime-missing recent device", () => {
    const recent = new RecentDevices(["A"])
    const available = [device("A", false), device("B")]

    expect(recent.preferredDevice(available)?.udid).toBe("B")
  })
})
