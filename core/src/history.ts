import type { BuildIdentity } from "./build.ts"
import type { ReferenceDate } from "./date.ts"
import type { DeviceContext } from "./deviceContext.ts"
import { filedIssueOf, type ReviewSession } from "./reviewSession.ts"
import type { FiledIssue, YouTrackProject, YouTrackUser } from "./youtrack.ts"

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
 * moment the metadata block's session line carries, and in the shared
 * History who filed it.
 */
export interface HistoryEntry {
  readonly build: BuildIdentity
  readonly project: YouTrackProject
  readonly startedAt: ReferenceDate
  /** Every filed Finding, in Tray order. */
  readonly findings: ReadonlyArray<FiledFinding>
  /**
   * The Reviewer whose token filed the Issues. Absent in the Swift app's
   * own History files, which had one Reviewer.
   */
  readonly filedBy?: YouTrackUser
}

/**
 * The entry a filed session records, ported from recordInHistory in
 * Sources/NitpickCore/SessionPersistence.swift: every filed Finding, with the
 * Design Reference its Issue was created under.
 */
export function historyEntry(session: ReviewSession): HistoryEntry {
  return {
    build: session.build.identity,
    project: session.project,
    startedAt: session.startedAt,
    findings: session.tray.flatMap((item) => {
      const issue = filedIssueOf(item)
      if (issue === undefined) return []
      const { summary, description, deviceContext, designReference } =
        item.finding
      return [
        designReference === undefined
          ? { summary, description, deviceContext, issue }
          : { summary, description, deviceContext, designReference, issue },
      ]
    }),
  }
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

/**
 * The entries `reviewer` filed, still newest first: their own History, the
 * only one they read.
 */
export function historyFiledBy(
  history: ReadonlyArray<HistoryEntry>,
  reviewer: Pick<YouTrackUser, "login">
): HistoryEntry[] {
  return history.filter((entry) => entry.filedBy?.login === reviewer.login)
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
