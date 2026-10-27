// Ports Tests/NitpickCoreTests/HistoryTraceTests.swift.
import { describe, expect, test } from "vitest"
import { referenceDate } from "../src/date.ts"
import { historyTrace, type HistoryEntry } from "../src/history.ts"
import type { FiledIssue } from "../src/youtrack.ts"

function issue(idReadable: string, suffix: string): FiledIssue {
  return {
    idReadable,
    url: `https://nitpick.youtrack.local/issue/${suffix}`,
  }
}

function entry(
  unixSeconds: number,
  issues: ReadonlyArray<FiledIssue>
): HistoryEntry {
  return {
    build: { bundleID: "ch.liip.nitpick", version: "1.2.3", buildNumber: "42" },
    project: { id: "0-1", shortName: "NP", name: "Nitpick" },
    startedAt: referenceDate(new Date(unixSeconds * 1000)),
    findings: issues.map((filed, index) => ({
      summary: `Finding ${index + 1}`,
      description: `Description ${index + 1}`,
      deviceContext: {
        deviceModel: "iPhone 17 Pro",
        osName: "iOS 26.4",
        accessibilitySettings: [],
      },
      issue: filed,
    })),
  }
}

const olderEntry = entry(1_700_000_000, [issue("OLD-1", "old-1")])

describe("History trace value", () => {
  test("no history produces no trace", () => {
    expect(historyTrace([])).toBeUndefined()
  })

  test("one filed issue stays visible without overflow", () => {
    const latest = entry(1_800_000_000, [issue("NP-101", "np-101")])
    const trace = historyTrace([latest, olderEntry])

    expect(trace?.latestEntry.startedAt).toBe(latest.startedAt)
    expect(trace?.visibleIssues.map((filed) => filed.idReadable)).toEqual([
      "NP-101",
    ])
    expect(trace?.visibleIssues.map((filed) => filed.url)).toEqual([
      "https://nitpick.youtrack.local/issue/np-101",
    ])
    expect(trace?.overflowCount).toBe(0)
  })

  test("exactly three issues stay visible without overflow", () => {
    const latest = entry(1_800_000_100, [
      issue("NP-201", "np-201"),
      issue("NP-202", "np-202"),
      issue("NP-203", "np-203"),
    ])
    const trace = historyTrace([latest, olderEntry])

    expect(trace?.visibleIssues.map((filed) => filed.idReadable)).toEqual([
      "NP-201",
      "NP-202",
      "NP-203",
    ])
    expect(trace?.overflowCount).toBe(0)
  })

  test("more than three issues caps at three and counts overflow", () => {
    const latest = entry(1_800_000_200, [
      issue("NP-301", "np-301"),
      issue("NP-302", "np-302"),
      issue("NP-303", "np-303"),
      issue("NP-304", "np-304"),
      issue("NP-305", "np-305"),
    ])
    const trace = historyTrace([latest, olderEntry])

    expect(trace?.visibleIssues.map((filed) => filed.idReadable)).toEqual([
      "NP-301",
      "NP-302",
      "NP-303",
    ])
    expect(trace?.visibleIssues.map((filed) => filed.url)).toEqual([
      "https://nitpick.youtrack.local/issue/np-301",
      "https://nitpick.youtrack.local/issue/np-302",
      "https://nitpick.youtrack.local/issue/np-303",
    ])
    expect(trace?.overflowCount).toBe(2)
  })
})
