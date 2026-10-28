// Not a port: the Swift app has no Android. Pins the Android Finding's
// metadata block (ADR-0004) and its Accessibility tokens (ADR-0013).
import { describe, expect, test } from "vitest"
import { buildPlatform } from "../src/build.ts"
import { referenceDate } from "../src/date.ts"
import {
  androidAccessibilityDescriptions,
  defaultAndroidDeviceSettings,
  deviceContextOf,
} from "../src/deviceContext.ts"
import {
  metadataBlock,
  newFinding,
  newReviewSession,
} from "../src/reviewSession.ts"

const apk = {
  identity: {
    bundleID: "dev.nitpick.fixture.smokedroid",
    version: "1.4.0",
    buildNumber: "42",
  },
  appBundleURL: "file:///data/builds/SmokeDroid.apk",
}

const session = newReviewSession({
  build: apk,
  project: { id: "0-12", shortName: "RM", name: "ReviewMe" },
  startedAt: referenceDate(new Date("2026-07-04T09:15:32Z")),
})

const emulator = { name: "Pixel 10", osName: "Android 17" }

function blockFor(settings = defaultAndroidDeviceSettings): string {
  const finding = newFinding({
    summary: "Button color is off",
    description: "",
    deviceContext: deviceContextOf(emulator, settings),
  })
  return metadataBlock(session, finding)
}

describe("Android metadata block", () => {
  test("the package name fills App's ID slot, and Device names the emulator and Android", () => {
    expect(blockFor()).toBe(
      [
        "---",
        "App: dev.nitpick.fixture.smokedroid 1.4.0 (42)",
        "Device: Pixel 10 — Android 17",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("every non-default setting renders in the iOS line's order", () => {
    expect(
      blockFor({
        platform: "android",
        fontScale: 1.3,
        darkTheme: true,
        highContrastText: true,
      })
    ).toBe(
      [
        "---",
        "App: dev.nitpick.fixture.smokedroid 1.4.0 (42)",
        "Device: Pixel 10 — Android 17",
        "Accessibility: Font Size 130%, Dark Mode, High Contrast Text",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })
})

describe("Android Accessibility tokens", () => {
  const tokens = (
    fontScale: number,
    darkTheme = false,
    highContrastText = false
  ) =>
    androidAccessibilityDescriptions({
      platform: "android",
      fontScale,
      darkTheme,
      highContrastText,
    })

  test("each setting is left out at its default", () => {
    expect(tokens(1)).toEqual([])
  })

  test("the font scale is a whole percentage, as Android's own steps give it", () => {
    expect(
      [0.85, 1.15, 1.3, 1.5, 1.8, 2].map((scale) => tokens(scale))
    ).toEqual([
      ["Font Size 85%"],
      ["Font Size 115%"],
      ["Font Size 130%"],
      ["Font Size 150%"],
      ["Font Size 180%"],
      ["Font Size 200%"],
    ])
  })

  test("a scale that rounds to 100% is the default", () => {
    expect(tokens(1.004)).toEqual([])
  })

  test("Dark Mode and High Contrast Text stand alone", () => {
    expect(tokens(1, true)).toEqual(["Dark Mode"])
    expect(tokens(1, false, true)).toEqual(["High Contrast Text"])
  })
})

describe("Build platform", () => {
  test("an .apk is an Android Build, an .app an iOS one", () => {
    expect(buildPlatform(apk)).toBe("android")
    expect(buildPlatform({ appBundleURL: "file:///tmp/ReviewMe.app/" })).toBe(
      "ios"
    )
  })
})
