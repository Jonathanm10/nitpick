import type { BuildIdentity } from "./build.ts"
import type { ReferenceDate } from "./date.ts"
import type { DeviceContext } from "./device-context.ts"
import type { FiledIssue, YouTrackProject } from "./youtrack.ts"

/**
 * A filed Finding's read-only record. Its screenshots stay on the filed
 * Issue, so the entry stays lean.
 */
export interface FiledFinding {
  readonly summary: string
  readonly description: string
  readonly deviceContext: DeviceContext
  /** The Design Reference the Issue was filed under, frozen at creation. */
  readonly designReference?: string
  readonly issue: FiledIssue
}

/**
 * A filed Review Session: what was reviewed and what its Findings became.
 * A log entry, never a mirror of YouTrack. Its identity is `startedAt`, the
 * moment the metadata block's session line carries.
 */
export interface HistoryEntry {
  readonly build: BuildIdentity
  readonly project: YouTrackProject
  readonly startedAt: ReferenceDate
  /** Every filed Finding, in Tray order. */
  readonly findings: ReadonlyArray<FiledFinding>
}

/**
 * The home trace: the last filed Review Session and the Issues it can show
 * inline, capped so home never regrows into a list.
 */
export interface HistoryTrace {
  readonly latestEntry: HistoryEntry
  readonly visibleIssues: ReadonlyArray<FiledIssue>
  readonly overflowCount: number
}

/** History is newest first; an empty History has no trace. */
export function historyTrace(
  history: ReadonlyArray<HistoryEntry>
): HistoryTrace | undefined {
  const [latestEntry] = history
  if (latestEntry === undefined) return undefined
  const visibleIssues = latestEntry.findings
    .slice(0, 3)
    .map((finding) => finding.issue)
  return {
    latestEntry,
    visibleIssues,
    overflowCount: latestEntry.findings.length - visibleIssues.length,
  }
}
