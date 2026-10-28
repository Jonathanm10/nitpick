// Filing a Review Session's Tray, ported from Sources/NitpickCore/IssueFiling.swift.
// Each Finding climbs a ladder: create the Issue, attach its images, apply
// `design-review`, apply its `nitpick-type:*` tag. Every step the instance
// acknowledges is recorded on the Tray and saved before the next request, so
// a failure or a server restart resumes the ladder without repeating a step
// (ADR-0008).
import type { Annotation } from "./annotation.ts"
import {
  designSnapshotContentType,
  effectiveAttachmentNames,
  type DesignSnapshot,
} from "./designSnapshot.ts"
import { historyEntry, type HistoryEntry } from "./history.ts"
import {
  effectiveDesignReference,
  filedIssueOf,
  findingsNeedingSummary,
  issueDescription,
  type Finding,
  type ReviewSession,
  type TrayItem,
} from "./reviewSession.ts"
import { trimWhitespaceAndNewlines } from "./text.ts"
import { findingTypeTagName } from "./triage.ts"
import {
  applyTag,
  attach,
  createIssue,
  tagID,
  type AttachmentFile,
  type CreatedIssue,
  type IssueCustomField,
} from "./youTrackIssueAPI.ts"
import { issueURL, YouTrackError, type YouTrackClient } from "./youtrack.ts"

/**
 * The tag every filed Issue carries: the query key for the review backlog
 * and for the planned v2 verify pass (ADR-0004).
 */
export const designReviewTagName = "design-review"

/**
 * A triage field the create had to leave out, with the value the designer
 * meant, so the page can tell them to set it by hand (ADR-0008). Never
 * stored: History and the filed Issue are unchanged.
 */
export interface DroppedTriageField {
  readonly field: "priority" | "assignee"
  /** Human-readable: the Priority's name, the Assignee's full name. */
  readonly intendedValue: string
}

/** The field's name as the designer knows it. */
export function droppedTriageFieldLabel(
  field: DroppedTriageField["field"]
): string {
  return field === "priority" ? "Priority" : "Assignee"
}

/**
 * The toast naming each triage field a run had to drop, with the value meant,
 * so the Reviewer can set it by hand: AppModel.presentDroppedFieldNotice's
 * text. Undefined when nothing was dropped.
 */
export function droppedFieldNotice(
  droppedFields: FileAllOutcome["droppedFields"]
): string | undefined {
  const all = Object.values(droppedFields).flat()
  if (all.length === 0) return undefined
  const phrases = [
    ...new Set(
      all.map(
        ({ field, intendedValue }) =>
          `${droppedTriageFieldLabel(field)} “${intendedValue}”`
      )
    ),
  ].sort()
  const list = phrases.join(", ")
  return all.length === 1
    ? `Couldn’t set ${list} — set it in YouTrack by hand.`
    : `Couldn’t set some triage fields (${list}) — set them in YouTrack by hand.`
}

/** Where filing reads a Finding's images and records its progress. */
export interface FilingStore {
  /**
   * Saves the open session. File all saves before its first request, which
   * also stores typed text not yet saved, and after every acknowledged step.
   * A refused save stops the run.
   */
  saveOpenSession(session: ReviewSession): Promise<void>
  /**
   * Records the fully filed session in History and clears the open slot. A
   * later File all of the same session replaces its entry, keyed by
   * `startedAt`.
   */
  recordInHistory(entry: HistoryEntry): Promise<void>
  /** The capture's PNG, as taken. */
  capturePNG(itemID: string): Promise<Uint8Array>
  designSnapshotData(
    itemID: string,
    snapshot: DesignSnapshot
  ): Promise<Uint8Array>
}

/**
 * Flattens Annotations into a PNG at its native size, and returns the bytes
 * unchanged when there are none. The server's rasterizer does it.
 */
export type Flatten = (
  png: Uint8Array,
  annotations: ReadonlyArray<Annotation>
) => Promise<Uint8Array>

export interface Filing {
  readonly youTrack: YouTrackClient
  readonly store: FilingStore
  readonly flatten: Flatten
  /** Called with the session each time one more Finding has filed. */
  readonly onProgress?: (session: ReviewSession) => void
}

/** What a File all run left behind. Progress is never thrown away. */
export interface FileAllOutcome {
  /** The session with every step the run completed recorded on its Tray. */
  readonly session: ReviewSession
  /**
   * Undefined when every remaining Finding filed; otherwise what stopped the
   * run. File all on the returned session files only what's missing.
   */
  readonly failure?: unknown
  /**
   * Per tray item id, the triage fields its create had to leave out. Empty
   * for a clean run; never stored.
   */
  readonly droppedFields: Readonly<
    Record<string, ReadonlyArray<DroppedTriageField>>
  >
}

/**
 * Files every Finding not yet filed, in Tray order, one Issue each. Each
 * Finding's ladder saves every acknowledged step before the next request, so
 * a failure, or the server dying mid-run, loses nothing: filed Findings stay
 * marked, untouched ones stay editable, and filing again resumes where the
 * run stopped. When the whole Tray has filed, the session goes to History.
 */
export async function fileAll(
  session: ReviewSession,
  filing: Filing
): Promise<FileAllOutcome> {
  let updated = session
  const droppedFields: Record<string, DroppedTriageField[]> = {}
  const remaining = session.tray.filter(
    (item) => filedIssueOf(item) === undefined
  )
  if (remaining.length === 0) return { session, droppedFields }
  try {
    // Check every summary and render every image before the first request:
    // a missing summary or an unreadable capture on the last Finding must
    // stop the run before it half-files the Tray.
    const needingSummary = new Set(findingsNeedingSummary(session))
    const pending: { readonly id: string; readonly files: AttachmentFile[] }[] =
      []
    for (const item of remaining) {
      if (needingSummary.has(item.id)) {
        throw new YouTrackError({ kind: "summaryRequired" })
      }
      pending.push({
        id: item.id,
        files: attachesLater(item) ? await attachmentFiles(item, filing) : [],
      })
    }
    // Typed text may not be saved yet. Saving it first means a restart
    // resumes with it, and a refused save stops the run before it creates
    // an Issue it could never mark as filed.
    await filing.store.saveOpenSession(updated)
    // Every tag is resolved before any Issue exists, so a refused tag
    // creation leaves no orphan Issue. Each Type present adds its tag, in a
    // stable order, so a mixed run sends the same requests every time.
    const designReviewTagID = await tagID(filing.youTrack, designReviewTagName)
    const typeTagIDs = new Map<string, string>()
    const typeTagNames = [
      ...new Set(
        remaining.map((item) => findingTypeTagName(item.finding.type))
      ),
    ].sort()
    for (const name of typeTagNames) {
      typeTagIDs.set(name, await tagID(filing.youTrack, name))
    }
    for (const { id, files } of pending) {
      for (;;) {
        const item = trayItem(updated, id)
        if (filedIssueOf(item) !== undefined) break
        const step = await climbOneRung(item, session, filing.youTrack, {
          files,
          designReviewTagID,
          // Resolved above for the Type of every remaining Finding.
          typeTagID: typeTagIDs.get(findingTypeTagName(item.finding.type))!,
        })
        updated = {
          ...updated,
          tray: updated.tray.map((candidate) =>
            candidate.id === id ? step.item : candidate
          ),
        }
        if (step.dropped.length > 0) {
          droppedFields[id] = [...(droppedFields[id] ?? []), ...step.dropped]
        }
        await filing.store.saveOpenSession(updated)
      }
      filing.onProgress?.(updated)
    }
    await filing.store.recordInHistory(historyEntry(updated))
    return { session: updated, droppedFields }
  } catch (failure) {
    return { session: updated, failure, droppedFields }
  }
}

/** Whether the item's ladder still has its attachments rung ahead: the
 * others need no images. */
function attachesLater(item: TrayItem): boolean {
  const { state } = item.filingProgress
  return state === "notStarted" || state === "issueCreated"
}

/**
 * The images one request attaches: the annotated screenshot first, the clean
 * original second, then the Design Snapshots under names that never collide.
 * Annotations freeze into the image here, the moment editing ends.
 */
async function attachmentFiles(
  item: TrayItem,
  filing: Filing
): Promise<AttachmentFile[]> {
  const capture = await filing.store.capturePNG(item.id)
  const annotated = await filing.flatten(capture, item.finding.annotations)
  const snapshots = item.finding.designSnapshots
  const names = effectiveAttachmentNames(snapshots, [
    "annotated.png",
    "original.png",
  ])
  const files: AttachmentFile[] = [
    { fileName: "annotated.png", contentType: "image/png", data: annotated },
    { fileName: "original.png", contentType: "image/png", data: capture },
  ]
  for (const [index, snapshot] of snapshots.entries()) {
    files.push({
      fileName: names[index],
      contentType: designSnapshotContentType(snapshot.mediaType),
      data: await filing.store.designSnapshotData(item.id, snapshot),
    })
  }
  return files
}

/**
 * Climbs one rung of an item's ladder and returns the item with the step the
 * instance acknowledged. On a throw the item keeps its last mark, which is
 * what makes filing resumable. Tags are resolved before the first rung, so a
 * rung only ever applies one.
 */
async function climbOneRung(
  item: TrayItem,
  session: ReviewSession,
  youTrack: YouTrackClient,
  rung: {
    readonly files: ReadonlyArray<AttachmentFile>
    readonly designReviewTagID: string
    readonly typeTagID: string
  }
): Promise<{
  readonly item: TrayItem
  readonly dropped: ReadonlyArray<DroppedTriageField>
}> {
  const progress = item.filingProgress
  switch (progress.state) {
    case "notStarted": {
      const created = await createFindingIssue(item.finding, session, youTrack)
      // The description just sent used the effective Design Reference.
      // Freeze it on the Finding now that the Issue exists, so the Tray and
      // later History never diverge from what the Issue says, even if the
      // session's reference changes before a retry.
      const designReference = effectiveDesignReference(session, item.finding)
      const finding: Finding =
        designReference === undefined
          ? item.finding
          : { ...item.finding, designReference }
      return {
        item: {
          ...item,
          finding,
          filingProgress: {
            state: "issueCreated",
            issueID: created.issue.id,
            idReadable: created.issue.idReadable,
          },
        },
        dropped: created.dropped,
      }
    }
    case "issueCreated":
      // Attach before tagging: if attaching fails, the Issue stays untagged,
      // invisible to the backlog query and the verify pass, rather than
      // tagged but missing its screenshots.
      await attach(
        youTrack,
        rung.files,
        progress.issueID,
        "attach the screenshots"
      )
      return {
        item: {
          ...item,
          filingProgress: { ...progress, state: "attachmentsUploaded" },
        },
        dropped: [],
      }
    case "attachmentsUploaded":
      await applyTag(
        youTrack,
        rung.designReviewTagID,
        progress.issueID,
        designReviewTagName
      )
      return {
        item: {
          ...item,
          filingProgress: { ...progress, state: "reviewTagged" },
        },
        dropped: [],
      }
    case "reviewTagged":
      // The Type tag goes last, one tag per request (ADR-0008): a failure
      // here resumes at this rung alone, never re-applying design-review.
      await applyTag(
        youTrack,
        rung.typeTagID,
        progress.issueID,
        findingTypeTagName(item.finding.type)
      )
      return {
        item: {
          ...item,
          filingProgress: {
            state: "filed",
            issue: {
              idReadable: progress.idReadable,
              url: issueURL(
                youTrack.credentials.instanceURL,
                progress.idReadable
              ),
            },
          },
        },
        dropped: [],
      }
    case "filed":
      return { item, dropped: [] }
  }
}

/**
 * Creates the Issue with the Finding's Priority and Assignee as native
 * custom fields. Summary and project are already checked, so a 400 while
 * custom fields were sent is put down to them: the create is retried once
 * without them, the Finding still files, and the dropped fields are
 * reported. If that retry fails too, its error propagates. Auth (401, 403),
 * network and project-gone (404) failures are never retried (ADR-0008).
 */
async function createFindingIssue(
  finding: Finding,
  session: ReviewSession,
  youTrack: YouTrackClient
): Promise<{
  readonly issue: CreatedIssue
  readonly dropped: ReadonlyArray<DroppedTriageField>
}> {
  const customFields = triageCustomFields(finding)
  const create = (fields?: ReadonlyArray<IssueCustomField>) =>
    createIssue(youTrack, {
      project: session.project,
      summary: trimWhitespaceAndNewlines(finding.summary),
      description: issueDescription(session, finding),
      customFields: fields,
    })
  if (customFields.length === 0) return { issue: await create(), dropped: [] }
  try {
    return { issue: await create(customFields), dropped: [] }
  } catch (error) {
    if (!isCustomFieldRejection(error)) throw error
    return { issue: await create(), dropped: droppedTriageFields(finding) }
  }
}

function isCustomFieldRejection(error: unknown): boolean {
  return (
    error instanceof YouTrackError &&
    error.failure.kind === "unexpectedResponse" &&
    error.failure.statusCode === 400
  )
}

/** Priority before Assignee, so create bodies stay byte-stable. */
function triageCustomFields(finding: Finding): IssueCustomField[] {
  const fields: IssueCustomField[] = []
  if (finding.priority !== undefined) {
    fields.push({
      $type: "SingleEnumIssueCustomField",
      name: "Priority",
      value: { name: finding.priority.name },
    })
  }
  if (finding.assignee !== undefined) {
    fields.push({
      $type: "SingleUserIssueCustomField",
      name: "Assignee",
      value: { login: finding.assignee.login },
    })
  }
  return fields
}

function droppedTriageFields(finding: Finding): DroppedTriageField[] {
  const dropped: DroppedTriageField[] = []
  if (finding.priority !== undefined) {
    dropped.push({ field: "priority", intendedValue: finding.priority.name })
  }
  if (finding.assignee !== undefined) {
    dropped.push({
      field: "assignee",
      intendedValue: finding.assignee.fullName,
    })
  }
  return dropped
}

function trayItem(session: ReviewSession, id: string): TrayItem {
  const item = session.tray.find((candidate) => candidate.id === id)
  if (item === undefined) throw new Error(`no tray item ${id}`)
  return item
}
