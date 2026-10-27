// Ports the codec cases of Tests/NitpickCoreTests/DurabilityTests.swift: what
// a save writes, a relaunch reads back. Writing files, clearing the open slot
// and listing History are the server's; the filing halves are issue 05's.
import { describe, expect, test } from "vitest"
import type { Annotation } from "../src/annotation.ts"
import type { HistoryEntry } from "../src/history.ts"
import {
  addFinding,
  discardFinding,
  newFinding,
  updateFinding,
} from "../src/review-session.ts"
import {
  decodeStoredHistoryEntry,
  decodeStoredSession,
  encodeStoredHistoryEntry,
  encodeStoredSession,
  MalformedStoredData,
} from "../src/storage.ts"
import * as fixtures from "./fixtures.ts"

describe("Crash-safe sessions and history", () => {
  test("killing the app mid-session and relaunching restores the open session — tray, descriptions, editable Annotations", () => {
    const annotations: Annotation[] = [
      {
        kind: "pen",
        color: "yellow",
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
      { kind: "arrow", color: "red", from: { x: 5, y: 6 }, to: { x: 7, y: 8 } },
      {
        kind: "rectangle",
        color: "blue",
        rect: { x: 10, y: 20, width: 30, height: 40 },
      },
      { kind: "label", color: "white", text: "Wrong red", at: { x: 9, y: 10 } },
    ]
    const annotated = addFinding(fixtures.session, {
      ...newFinding({
        summary: "Button color is off",
        description: "The primary button is #FF0000, the design says #E64545.",
        deviceContext: {
          deviceModel: "iPhone 17 Pro",
          osName: "iOS 26.4",
          accessibilitySettings: [],
        },
        designReference: "https://www.figma.com/design/abc/buttons",
      }),
      annotations,
    })
    const second = addFinding(
      annotated.session,
      newFinding({
        summary: "",
        description: "",
        deviceContext: {
          deviceModel: "iPad Pro 13-inch (M4)",
          osName: "iOS 26.4",
          accessibilitySettings: ["Dynamic Type XL", "Dark Mode"],
        },
      })
    )
    // Later edits persist too — the newest save wins.
    const session = updateFinding(second.session, second.id, (finding) => ({
      ...finding,
      summary: "Label truncates",
    }))
    const saved = encodeStoredSession(session)

    const resumed = decodeStoredSession(saved)
    expect(resumed).toEqual(session)

    // Annotations are still editable after the relaunch. Their undo history
    // is issue 04's.
    const edited = updateFinding(resumed, annotated.id, (finding) => ({
      ...finding,
      annotations: finding.annotations.slice(1),
    }))
    expect(edited.tray[0].finding.annotations).toHaveLength(3)
  })

  test("a session persisted before Type shipped still decodes — its Findings default to Bug — and files to completion", () => {
    const { session } = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Filed by an older nitpick" })
    )
    const stored = JSON.parse(encodeStoredSession(session))
    // The pre-Type shape: no `type` key on any tray item.
    for (const item of stored.tray) delete item.type

    const reloaded = decodeStoredSession(JSON.stringify(stored))

    expect(reloaded.tray[0].finding.type).toBe("bug")
    expect(reloaded).toEqual(session)
  })

  test("a discarded Finding stays discarded after the relaunch", () => {
    const kept = addFinding(
      fixtures.session,
      fixtures.finding({ summary: "Keep me" })
    )
    const dropped = addFinding(
      kept.session,
      fixtures.finding({ summary: "Not a real problem" })
    )
    const session = discardFinding(dropped.session, dropped.id)

    const resumed = decodeStoredSession(encodeStoredSession(session))

    expect(resumed).toEqual(session)
    expect(resumed.tray.map((item) => item.finding.summary)).toEqual([
      "Keep me",
    ])
  })

  test("the session-level Design Reference survives the relaunch", () => {
    const { session } = addFinding(
      {
        ...fixtures.session,
        designReference: "https://www.figma.com/file/sess42/ReviewMe",
      },
      fixtures.finding()
    )

    const resumed = decodeStoredSession(encodeStoredSession(session))

    expect(resumed).toEqual(session)
    expect(resumed.designReference).toBe(
      "https://www.figma.com/file/sess42/ReviewMe"
    )
  })

  test("a corrupt open-session file is a thrown error, not a silently empty state", () => {
    const { session } = addFinding(fixtures.session, fixtures.finding())
    const valid = encodeStoredSession(session)

    expect(() => decodeStoredSession("not json")).toThrow(MalformedStoredData)
    // Valid JSON in the wrong shape is just as corrupt.
    expect(() =>
      decodeStoredSession(valid.replace('"summary":', '"summery":'))
    ).toThrow(MalformedStoredData)
    expect(() =>
      decodeStoredSession(valid.replace('"type":"bug"', '"type":"feature"'))
    ).toThrow(MalformedStoredData)
  })

  test("filed sessions land in history with their issue links — read from disk, never from YouTrack", () => {
    const entry: HistoryEntry = {
      build: fixtures.session.build.identity,
      project: fixtures.session.project,
      startedAt: fixtures.session.startedAt,
      findings: [
        {
          summary: "Toolbar icon is misaligned",
          description:
            "The primary button is #FF0000, the design says #E64545.",
          deviceContext: {
            deviceModel: "iPhone 17 Pro",
            osName: "iOS 26.4",
            accessibilitySettings: [],
          },
          issue: fixtures.filedIssue("RM-421"),
        },
        {
          summary: "Label truncates",
          description:
            "The primary button is #FF0000, the design says #E64545.",
          deviceContext: {
            deviceModel: "iPhone 17 Pro",
            osName: "iOS 26.4",
            accessibilitySettings: [],
          },
          issue: fixtures.filedIssue("RM-422"),
        },
      ],
    }

    expect(decodeStoredHistoryEntry(encodeStoredHistoryEntry(entry))).toEqual(
      entry
    )
  })
})
