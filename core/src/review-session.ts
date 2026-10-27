import type { Annotation } from "./annotation.ts"
import type { Build } from "./build.ts"
import { iso8601, referenceDate, type ReferenceDate } from "./date.ts"
import type { DesignSnapshot } from "./design-snapshot.ts"
import type { DeviceContext } from "./device-context.ts"
import type { FindingAssignee, FindingPriority, FindingType } from "./triage.ts"
import { newUUID } from "./uuid.ts"
import type { FiledIssue, YouTrackProject } from "./youtrack.ts"

/**
 * A single point of design-review feedback on the Build, filed as exactly one
 * Issue. Its screenshot lives beside the stored session, named by its tray
 * item's id, so the value holds no image bytes.
 */
export interface Finding {
  readonly summary: string
  /** The designer's text; the metadata block is appended at filing. */
  readonly description: string
  readonly deviceContext: DeviceContext
  readonly annotations: ReadonlyArray<Annotation>
  /** Overrides the session's Design Reference (ADR-0003). */
  readonly designReference?: string
  readonly designSnapshots: ReadonlyArray<DesignSnapshot>
  readonly type: FindingType
  /** Absent takes the project's default Priority. */
  readonly priority?: FindingPriority
  /** Absent is unassigned, a valid state. */
  readonly assignee?: FindingAssignee
}

/** A fresh capture's Finding: a Bug with no Annotations or Design Snapshots. */
export function newFinding(fields: {
  readonly summary: string
  readonly description: string
  readonly deviceContext: DeviceContext
  readonly designReference?: string
  readonly type?: FindingType
  readonly priority?: FindingPriority
  readonly assignee?: FindingAssignee
}): Finding {
  return {
    ...fields,
    annotations: [],
    designSnapshots: [],
    type: fields.type ?? "bug",
  }
}

/**
 * How far an item's filing has progressed. Filing records every
 * server-acknowledged step before the next request, so a retry resumes
 * instead of repeating.
 */
export type FilingProgress =
  | { readonly state: "notStarted" }
  | {
      /**
       * issueCreated: the Issue exists, bare. attachmentsUploaded: both
       * screenshots are attached. reviewTagged: only the Type tag remains.
       */
      readonly state: "issueCreated" | "attachmentsUploaded" | "reviewTagged"
      readonly issueID: string
      readonly idReadable: string
    }
  | { readonly state: "filed"; readonly issue: FiledIssue }

/** A Finding's seat in the Tray. Identity belongs to the Tray. */
export interface TrayItem {
  readonly id: string
  readonly finding: Finding
  readonly filingProgress: FilingProgress
}

/**
 * One sitting in which a designer reviews a Build, filing into one project.
 * Its Tray holds the Findings in capture order.
 */
export interface ReviewSession {
  readonly build: Build
  readonly project: YouTrackProject
  /** Rendered into every Issue's session line (ADR-0004). */
  readonly startedAt: ReferenceDate
  /** The Figma URL every Finding without its own files under (ADR-0003). */
  readonly designReference?: string
  readonly tray: ReadonlyArray<TrayItem>
}

export function newReviewSession(fields: {
  readonly build: Build
  readonly project: YouTrackProject
  readonly startedAt?: ReferenceDate
  readonly designReference?: string
}): ReviewSession {
  return {
    ...fields,
    startedAt: fields.startedAt ?? referenceDate(new Date()),
    tray: [],
  }
}

/** The Issue an item became, once the whole filing ladder ran. */
export function filedIssueOf(item: TrayItem): FiledIssue | undefined {
  return item.filingProgress.state === "filed"
    ? item.filingProgress.issue
    : undefined
}

/**
 * Editable and discardable only while nothing about the item exists on the
 * instance: once its Issue is created, the item freezes.
 */
export function isEditable(item: TrayItem): boolean {
  return item.filingProgress.state === "notStarted"
}

/**
 * Whether Esc may throw the Finding away: nothing the designer can set
 * differs from a fresh capture, and filing never touched it.
 */
export function isPristine(item: TrayItem): boolean {
  const { finding } = item
  return (
    isEditable(item) &&
    finding.annotations.length === 0 &&
    isBlank(finding.summary) &&
    isBlank(finding.description) &&
    finding.designSnapshots.length === 0 &&
    finding.designReference === undefined &&
    finding.type === "bug" &&
    finding.priority === undefined &&
    finding.assignee === undefined
  )
}

/** Drops a capture into the Tray, with no filing dialog. */
export function addFinding(
  session: ReviewSession,
  finding: Finding
): { readonly session: ReviewSession; readonly id: string } {
  const id = newUUID()
  return {
    session: {
      ...session,
      tray: [
        ...session.tray,
        { id, finding, filingProgress: { state: "notStarted" } },
      ],
    },
    id,
  }
}

/**
 * Edits an item's Finding. Refused, returning the same session, once the
 * item is frozen: the Tray must never diverge from its Issue.
 */
export function updateFinding(
  session: ReviewSession,
  id: string,
  edit: (finding: Finding) => Finding
): ReviewSession {
  const index = session.tray.findIndex((item) => item.id === id)
  if (index === -1 || !isEditable(session.tray[index])) return session
  const tray = [...session.tray]
  tray[index] = { ...tray[index], finding: edit(tray[index].finding) }
  return { ...session, tray }
}

/** Removes an item before filing. A created Issue keeps its Tray record. */
export function discardFinding(
  session: ReviewSession,
  id: string
): ReviewSession {
  return {
    ...session,
    tray: session.tray.filter((item) => item.id !== id || !isEditable(item)),
  }
}

/** Every Issue the Tray's Findings have become, in Tray order. */
export function filedIssues(session: ReviewSession): FiledIssue[] {
  return session.tray.flatMap((item) => filedIssueOf(item) ?? [])
}

/**
 * Findings short of the full ladder, including one frozen mid-ladder: the
 * count the drop guard names and File all shows.
 */
export function unfiledFindingCount(session: ReviewSession): number {
  return session.tray.filter((item) => filedIssueOf(item) === undefined).length
}

/** The drop guard's predicate: only filed work survives a new Build. */
export function hasUnfiledFindings(session: ReviewSession): boolean {
  return unfiledFindingCount(session) > 0
}

/**
 * The Findings that keep File all from running, in Tray order: editable, so
 * filing would create their Issue, yet without the summary it needs.
 */
export function findingsNeedingSummary(session: ReviewSession): string[] {
  return session.tray
    .filter((item) => isEditable(item) && isBlank(item.finding.summary))
    .map((item) => item.id)
}

/**
 * The Design Reference a Finding files under: its own, else the session's,
 * else none.
 */
export function effectiveDesignReference(
  session: ReviewSession,
  finding: Finding
): string | undefined {
  return finding.designReference ?? session.designReference
}

/**
 * The block appended to every filed Issue's description: a machine contract
 * (ADR-0004), byte-stable and golden-tested. Any change here is a versioned
 * schema change.
 */
export function metadataBlock(
  session: ReviewSession,
  finding: Finding
): string {
  const { identity } = session.build
  const { deviceContext } = finding
  const lines = [
    "---",
    `App: ${identity.bundleID} ${identity.version} (${identity.buildNumber})`,
    `Device: ${deviceContext.deviceModel} — ${deviceContext.osName}`,
  ]
  if (deviceContext.accessibilitySettings.length > 0) {
    lines.push(
      `Accessibility: ${deviceContext.accessibilitySettings.join(", ")}`
    )
  }
  const designReference = effectiveDesignReference(session, finding)
  if (designReference !== undefined) lines.push(`Design: ${designReference}`)
  lines.push(`Filed with nitpick — session ${iso8601(session.startedAt)}`)
  return lines.join("\n")
}

/**
 * The description a filed Issue carries: the designer's text, a blank line
 * and the metadata block, or the block alone when there is no text.
 */
export function issueDescription(
  session: ReviewSession,
  finding: Finding
): string {
  const designerText = trimWhitespaceAndNewlines(finding.description)
  const block = metadataBlock(session, finding)
  return designerText === "" ? block : `${designerText}\n\n${block}`
}

/**
 * Swift's `.whitespacesAndNewlines`: Unicode spaces (Zs), tab, U+000A–U+000D,
 * U+0085, U+200B, U+2028 and U+2029. Unlike JS's `trim`, it trims U+0085 and
 * U+200B and keeps U+FEFF. All of them are single UTF-16 code units.
 */
const whitespaceOrNewline = /^[\p{Zs}\t\n\v\f\r\u0085\u200b\u2028\u2029]$/u

// Scans in from each end, one code unit at a time: an anchored `\s+$`-style
// regex backtracks quadratically over a long inner run of spaces, and this
// text comes from the browser.
function trimWhitespaceAndNewlines(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && whitespaceOrNewline.test(text[start])) start++
  while (end > start && whitespaceOrNewline.test(text[end - 1])) end--
  return text.slice(start, end)
}

function isBlank(text: string): boolean {
  return trimWhitespaceAndNewlines(text) === ""
}
