// Not a port: the web app's Environment section and the dropped-field toast
// text. The Environment changes as parity.md's Feedback row says: the web
// app and server versions, the browser and OS, and the Device Host's macOS
// and Xcode, with the Build and Capture Source lines kept. The toast is
// AppModel.presentDroppedFieldNotice's text.
import { describe, expect, test } from "vitest"
import {
  browserDescription,
  environmentLines,
  feedbackDescription,
  webFeedbackEnvironment,
} from "../src/feedback.ts"
import { droppedFieldNotice } from "../src/issueFiling.ts"

const build = {
  bundleID: "ch.liip.reviewme",
  version: "2.1.0",
  buildNumber: "421",
}

describe("The web app's Environment", () => {
  const read = {
    webApp: "0.0.1 (3b9ef47)",
    server: "0.0.0 (3b9ef47)",
    browser: "Edge 131 on Windows",
    deviceHostMacOS: "Version 26.1 (Build 25B78)",
    deviceHostXcode: "26.1 (17B55)",
  }

  test("lists the page, the server, the browser and the Device Host, in order", () => {
    expect(environmentLines(webFeedbackEnvironment(read))).toEqual([
      { label: "Web app", value: "0.0.1 (3b9ef47)" },
      { label: "Server", value: "0.0.0 (3b9ef47)" },
      { label: "Browser", value: "Edge 131 on Windows" },
      { label: "Device Host macOS", value: "Version 26.1 (Build 25B78)" },
      { label: "Device Host Xcode", value: "26.1 (17B55)" },
    ])
  })

  test("a Review Session adds the Build and the device it runs on", () => {
    const environment = webFeedbackEnvironment({
      ...read,
      review: { build, device: { name: "iPhone 17 Pro", osName: "iOS 26.4" } },
    })

    expect(environmentLines(environment).slice(5)).toEqual([
      { label: "Build", value: "ch.liip.reviewme 2.1.0 (421)" },
      {
        label: "Capture Source",
        value: "Simulator — iPhone 17 Pro, iOS 26.4",
      },
    ])
    expect(
      webFeedbackEnvironment({ ...read, review: { build } }).captureSource
    ).toBe("Simulator (not running)")
  })

  test("what couldn't be read is sent as “unknown”", () => {
    expect(
      environmentLines(webFeedbackEnvironment({ server: " " })).map(
        (line) => line.value
      )
    ).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown"])
  })

  test("the description carries it as the Environment section", () => {
    expect(
      feedbackDescription({
        kind: "bug",
        title: "The History page forgets its scroll position",
        description: "",
        environment: webFeedbackEnvironment(read),
      })
    ).toBe(
      "## Environment\n- Web app: 0.0.1 (3b9ef47)\n- Server: 0.0.0 (3b9ef47)\n- Browser: Edge 131 on Windows\n- Device Host macOS: Version 26.1 (Build 25B78)\n- Device Host Xcode: 26.1 (17B55)"
    )
  })
})

describe("The browser and OS line", () => {
  test.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.70",
      "Edge 131 on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Chrome 131 on macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
      "Safari 26.1 on macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
      "Firefox 133 on Windows",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36",
      "Chrome 131 on Linux",
    ],
  ])("%s", (userAgent, expected) => {
    expect(browserDescription(userAgent)).toBe(expected)
  })

  test("an unknown browser has no line of its own", () => {
    expect(browserDescription("curl/8.7.1")).toBeUndefined()
  })
})

describe("The dropped-field toast", () => {
  test("nothing dropped, no toast", () => {
    expect(droppedFieldNotice({})).toBeUndefined()
  })

  test("one field names it and its value", () => {
    expect(
      droppedFieldNotice({
        a: [{ field: "priority", intendedValue: "Critical" }],
      })
    ).toBe("Couldn’t set Priority “Critical” — set it in YouTrack by hand.")
  })

  test("several list each field and value once, sorted", () => {
    expect(
      droppedFieldNotice({
        a: [
          { field: "priority", intendedValue: "Critical" },
          { field: "assignee", intendedValue: "Noor Haddad" },
        ],
        b: [{ field: "priority", intendedValue: "Critical" }],
      })
    ).toBe(
      "Couldn’t set some triage fields (Assignee “Noor Haddad”, Priority “Critical”) — set them in YouTrack by hand."
    )
  })
})
