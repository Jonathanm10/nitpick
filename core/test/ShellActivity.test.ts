// Ports Tests/NitpickCoreTests/ShellActivityTests.swift.
import { describe, expect, test } from "vitest"
import { ShellActivity, ShellBusy } from "../src/shellActivity.ts"

describe("Shell activity", () => {
  test("a fresh shell is idle", () => {
    const activity = new ShellActivity()

    expect(activity.isBusy).toBe(false)
    expect(activity.isFiling).toBe(false)
    expect(activity.filingFailure).toBeUndefined()
  })

  test("a File all run is busy and filing until it ends", () => {
    let activity = new ShellActivity().begin("filing")
    expect(activity.isBusy).toBe(true)
    expect(activity.isFiling).toBe(true)

    activity = activity.end()
    expect(activity.isBusy).toBe(false)
    expect(activity.isFiling).toBe(false)
  })

  test("other work is busy but not filing", () => {
    const activity = new ShellActivity().begin("other")

    expect(activity.isBusy).toBe(true)
    expect(activity.isFiling).toBe(false)
  })

  test("work that starts while File all runs is refused and filing keeps running", () => {
    const activity = new ShellActivity().begin("filing")

    expect(() => activity.begin("other")).toThrow(ShellBusy)
    expect(activity.running).toBe("filing")
  })

  test("work that starts while other work runs is refused", () => {
    const activity = new ShellActivity().begin("other")

    expect(() => activity.begin("filing")).toThrow(ShellBusy)
    expect(activity.running).toBe("other")
  })

  test("a refusal is an error with a message the designer can read", () => {
    const activity = new ShellActivity().begin("other")

    expect(() => activity.begin("other")).toThrow(
      "Nitpick was busy, so that didn’t run. Try again when the current step finishes."
    )
  })

  test("the next run starts once the current one ends", () => {
    const activity = new ShellActivity().begin("filing").end().begin("other")

    expect(activity.running).toBe("other")
  })

  test("a filing failure survives unrelated work", () => {
    const activity = new ShellActivity()
      .begin("filing")
      .recordFilingFailure("The network connection was lost.")
      .end()
      .begin("other")
      .end()

    expect(activity.filingFailure).toBe("The network connection was lost.")
  })

  test("the next File all run forgets the last failure", () => {
    const activity = new ShellActivity()
      .begin("filing")
      .recordFilingFailure("The request timed out.")
      .end()
      .begin("filing")

    expect(activity.filingFailure).toBeUndefined()
  })
})
