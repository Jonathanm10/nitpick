// Ports Tests/NitpickCoreTests/MetadataBlockTests.swift.
import { describe, expect, test } from "vitest"
import { referenceDate } from "../src/date.ts"
import {
  deviceContextOf,
  dynamicTypeDisplayName,
  dynamicTypeSizes,
} from "../src/deviceContext.ts"
import {
  metadataBlock,
  newFinding,
  newReviewSession,
  type Finding,
} from "../src/reviewSession.ts"

const session = newReviewSession({
  build: {
    identity: {
      bundleID: "ch.liip.reviewme",
      version: "2.1.0",
      buildNumber: "421",
    },
    appBundleURL: "file:///tmp/ReviewMe.app/",
  },
  project: { id: "0-12", shortName: "RM", name: "ReviewMe" },
  startedAt: referenceDate(new Date("2026-07-04T09:15:32Z")),
})

function finding({
  accessibilitySettings = [] as string[],
  designReference = undefined as string | undefined,
} = {}): Finding {
  return newFinding({
    summary: "Button color is off",
    description: "The primary button is #FF0000, the design says #E64545.",
    deviceContext: {
      deviceModel: "iPhone 17 Pro",
      osName: "iOS 26.4",
      accessibilitySettings,
    },
    designReference,
  })
}

describe("Metadata block golden", () => {
  test("default Device Context, no Design Reference: both conditional lines are absent", () => {
    expect(metadataBlock(session, finding())).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("non-default accessibility settings render one comma-joined line", () => {
    const stamped = finding({
      accessibilitySettings: ["Dynamic Type XL", "Dark Mode"],
    })
    expect(metadataBlock(session, stamped)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Accessibility: Dynamic Type XL, Dark Mode",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("a Design Reference renders as a Design line", () => {
    const referenced = finding({
      designReference: "https://www.figma.com/file/abc123/ReviewMe",
    })
    expect(metadataBlock(session, referenced)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Design: https://www.figma.com/file/abc123/ReviewMe",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("both conditional lines present, in contract order", () => {
    const full = finding({
      accessibilitySettings: ["Dynamic Type XL"],
      designReference: "https://www.figma.com/file/abc123/ReviewMe",
    })
    expect(metadataBlock(session, full)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Accessibility: Dynamic Type XL",
        "Design: https://www.figma.com/file/abc123/ReviewMe",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  // Session-level Design Reference (issue 09)

  const sessionWithReference = {
    ...session,
    designReference: "https://www.figma.com/file/sess42/ReviewMe",
  }

  test("a session-level Design Reference renders on every Finding without its own", () => {
    expect(metadataBlock(sessionWithReference, finding())).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Design: https://www.figma.com/file/sess42/ReviewMe",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("a Finding-level Design Reference overrides the session-level one", () => {
    const referenced = finding({
      designReference: "https://www.figma.com/file/abc123/ReviewMe",
    })
    expect(metadataBlock(sessionWithReference, referenced)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Design: https://www.figma.com/file/abc123/ReviewMe",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  // The Accessibility line fed by observed Device Settings (ADR-0009)

  const device = { name: "iPhone 17 Pro", osName: "iOS 26.4" }

  test("default Device Settings stamp no Accessibility line", () => {
    const stamped = { ...finding(), deviceContext: deviceContextOf(device) }
    expect(metadataBlock(session, stamped)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("non-default Device Settings render Dynamic Type then Dark Mode", () => {
    const stamped = {
      ...finding(),
      deviceContext: deviceContextOf(device, {
        dynamicTypeSize: "accessibility-large",
        appearance: "dark",
        increaseContrast: false,
      }),
    }
    expect(metadataBlock(session, stamped)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Accessibility: Dynamic Type AX2, Dark Mode",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("a non-default Dynamic Type size alone renders without Dark Mode", () => {
    const stamped = {
      ...finding(),
      deviceContext: deviceContextOf(device, {
        dynamicTypeSize: "extra-large",
        appearance: "light",
        increaseContrast: false,
      }),
    }
    expect(metadataBlock(session, stamped)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Accessibility: Dynamic Type XL",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("Increase Contrast renders after Dynamic Type and Dark Mode", () => {
    const stamped = {
      ...finding(),
      deviceContext: deviceContextOf(device, {
        dynamicTypeSize: "accessibility-large",
        appearance: "dark",
        increaseContrast: true,
      }),
    }
    expect(metadataBlock(session, stamped)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Accessibility: Dynamic Type AX2, Dark Mode, Increase Contrast",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("Increase Contrast alone renders without Dynamic Type or Dark Mode", () => {
    const stamped = {
      ...finding(),
      deviceContext: deviceContextOf(device, {
        dynamicTypeSize: "large",
        appearance: "light",
        increaseContrast: true,
      }),
    }
    expect(metadataBlock(session, stamped)).toBe(
      [
        "---",
        "App: ch.liip.reviewme 2.1.0 (421)",
        "Device: iPhone 17 Pro — iOS 26.4",
        "Accessibility: Increase Contrast",
        "Filed with nitpick — session 2026-07-04T09:15:32Z",
      ].join("\n")
    )
  })

  test("every Dynamic Type size has a pinned stamp name", () => {
    expect(dynamicTypeSizes.map(dynamicTypeDisplayName)).toEqual([
      "XS",
      "S",
      "M",
      "L",
      "XL",
      "XXL",
      "XXXL",
      "AX1",
      "AX2",
      "AX3",
      "AX4",
      "AX5",
    ])
  })
})
