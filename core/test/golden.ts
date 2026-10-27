// Reads the Swift app's golden files (core/test/golden/README.md) and builds
// the domain values their `.input.json` descriptions describe. The domain
// types share the descriptions' neutral shape; only dates differ, since a
// description gives both forms and the port keeps Swift's exact double.
import { readFileSync } from "node:fs"
import { expect } from "vitest"
import type { HistoryEntry } from "../src/history.ts"
import type { Finding, ReviewSession } from "../src/review-session.ts"

const goldenDirectory = new URL("./golden/", import.meta.url)

export function goldenText(path: string): string {
  return readFileSync(new URL(path, goldenDirectory), "utf8")
}

export function goldenInput<Input>(path: string): Input {
  return JSON.parse(goldenText(path)) as Input
}

/** Fails with a readable diff first, then on any byte the diff can't show. */
export function expectMatchesGolden(actual: string, path: string): void {
  const golden = readFileSync(new URL(path, goldenDirectory))
  expect(actual, path).toBe(golden.toString("utf8"))
  expect(Buffer.from(actual, "utf8").equals(golden), path).toBe(true)
}

interface DescribedDate {
  readonly iso8601: string
  readonly secondsSinceReferenceDate: number
}

export type DescribedSession = Omit<ReviewSession, "startedAt"> & {
  readonly startedAt: DescribedDate
}

export type DescribedHistoryEntry = Omit<HistoryEntry, "startedAt"> & {
  readonly startedAt: DescribedDate
}

export function sessionFrom(described: DescribedSession): ReviewSession {
  return {
    ...described,
    startedAt: described.startedAt.secondsSinceReferenceDate,
  }
}

export function historyEntryFrom(
  described: DescribedHistoryEntry
): HistoryEntry {
  return {
    ...described,
    startedAt: described.startedAt.secondsSinceReferenceDate,
  }
}

export interface SessionAndFinding {
  readonly session: DescribedSession
  readonly finding: Finding
}
