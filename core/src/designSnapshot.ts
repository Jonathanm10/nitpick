// Ported from Sources/NitpickCore/DesignSnapshot.swift. Checking that the
// bytes decode needs an image decoder, so the server does it; the names and
// the edits to a Finding's Design Snapshots are here.
import {
  isEditable,
  updateFinding,
  type ReviewSession,
} from "./reviewSession.ts"
import { trimWhitespaceAndNewlines } from "./text.ts"
import { newUUID } from "./uuid.ts"

export type DesignSnapshotMediaType = "png" | "jpeg"

export const designSnapshotMediaTypes: ReadonlyArray<DesignSnapshotMediaType> =
  ["png", "jpeg"]

/**
 * A named static image from the design, attached to a Finding (ADR-0011). Its
 * bytes live beside the stored session, named by `dataVersion`.
 */
export interface DesignSnapshot {
  readonly id: string
  /**
   * Names these exact bytes: Replace keeps `id` but mints a new
   * `dataVersion`, a rename keeps both. Starts equal to `id`.
   */
  readonly dataVersion: string
  readonly name: string
  readonly mediaType: DesignSnapshotMediaType
}

export function designSnapshotFileExtension(
  mediaType: DesignSnapshotMediaType
): string {
  return mediaType === "png" ? "png" : "jpg"
}

export function designSnapshotContentType(
  mediaType: DesignSnapshotMediaType
): string {
  return mediaType === "png" ? "image/png" : "image/jpeg"
}

/**
 * The names Design Snapshots file under: each keeps its name, unless it
 * matches a reserved name or an earlier one regardless of case, which gets
 * " (2)", " (3)"… before its extension. A name without an extension gets its
 * media type's. The names the designer sees don't change.
 */
export function effectiveAttachmentNames(
  snapshots: ReadonlyArray<DesignSnapshot>,
  reservedNames: ReadonlyArray<string>
): string[] {
  const used = new Set(reservedNames.map((name) => name.toLowerCase()))
  return snapshots.map((snapshot) => {
    const { base, extension } = splitPathExtension(snapshot.name)
    const fileExtension =
      extension === ""
        ? designSnapshotFileExtension(snapshot.mediaType)
        : extension
    let candidate = `${base}.${fileExtension}`
    for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
      candidate = `${base} (${suffix}).${fileExtension}`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * NSString's `pathExtension` and `deletingPathExtension`, as probed with
 * swift: the extension follows the last dot of the last path component,
 * unless that dot leads or ends it. Without an extension the name is kept
 * whole.
 */
function splitPathExtension(name: string): {
  readonly base: string
  readonly extension: string
} {
  let end = name.length
  while (end > 1 && name[end - 1] === "/") end--
  const path = name.slice(0, end)
  const componentStart = path.lastIndexOf("/") + 1
  const dot = path.lastIndexOf(".")
  if (dot <= componentStart || dot === path.length - 1) {
    return { base: name, extension: "" }
  }
  return { base: path.slice(0, dot), extension: path.slice(dot + 1) }
}

/** Why a Design Snapshot edit was refused, in today's words. */
export type DesignSnapshotFailure =
  | { readonly kind: "findingNotEditable" }
  | { readonly kind: "snapshotNotFound" }
  | { readonly kind: "emptyName" }
  | { readonly kind: "unreadableImage" }
  | {
      readonly kind: "mediaTypeMismatch"
      readonly expected: DesignSnapshotMediaType
    }
  | { readonly kind: "unsupportedFileType"; readonly fileExtension: string }

export class DesignSnapshotError extends Error {
  readonly failure: DesignSnapshotFailure

  constructor(failure: DesignSnapshotFailure) {
    super(designSnapshotErrorMessage(failure))
    this.name = "DesignSnapshotError"
    this.failure = failure
  }
}

function designSnapshotErrorMessage(failure: DesignSnapshotFailure): string {
  switch (failure.kind) {
    case "findingNotEditable":
      return "Design Snapshots can only be changed on an editable Finding."
    case "snapshotNotFound":
      return "This Design Snapshot is no longer attached to the Finding."
    case "emptyName":
      return "Give the Design Snapshot a name."
    case "unreadableImage":
      return "Choose a readable PNG or JPEG image."
    case "mediaTypeMismatch":
      return `This image is not a valid ${failure.expected === "png" ? "PNG" : "JPEG"} file.`
    case "unsupportedFileType":
      return `${failure.fileExtension === "" ? "This file" : `.${failure.fileExtension}`} is not supported. Choose a PNG or JPEG image.`
  }
}

/** The media type a file name's extension claims, or unsupportedFileType. */
export function designSnapshotMediaType(
  fileName: string
): DesignSnapshotMediaType {
  const { extension } = splitPathExtension(fileName)
  const mediaType = claimedMediaType(extension)
  if (mediaType === undefined) {
    throw new DesignSnapshotError({
      kind: "unsupportedFileType",
      fileExtension: extension,
    })
  }
  return mediaType
}

/**
 * A name whose extension tells the truth about `mediaType`: kept when it
 * already does, else its extension is swapped for `preferredExtension` when
 * that one fits, or the media type's own. Blank names are refused.
 */
export function normalizedDesignSnapshotName(
  name: string,
  mediaType: DesignSnapshotMediaType,
  preferredExtension?: string
): string {
  const trimmed = trimWhitespaceAndNewlines(name)
  if (trimmed === "") throw new DesignSnapshotError({ kind: "emptyName" })
  const { base, extension } = splitPathExtension(trimmed)
  if (claimedMediaType(extension) === mediaType) return trimmed
  const preferred =
    preferredExtension !== undefined &&
    claimedMediaType(preferredExtension) === mediaType
      ? preferredExtension
      : designSnapshotFileExtension(mediaType)
  return `${base}.${preferred}`
}

function claimedMediaType(
  extension: string
): DesignSnapshotMediaType | undefined {
  switch (extension.toLowerCase()) {
    case "png":
      return "png"
    case "jpg":
    case "jpeg":
      return "jpeg"
    default:
      return undefined
  }
}

/**
 * Adds a Design Snapshot to an editable Finding, after the caller checked
 * its bytes. Returns the snapshot, whose `id` and `dataVersion` name the
 * bytes to store.
 */
export function addDesignSnapshot(
  session: ReviewSession,
  findingID: string,
  file: { readonly name: string; readonly mediaType: DesignSnapshotMediaType }
): { readonly session: ReviewSession; readonly snapshot: DesignSnapshot } {
  editableFinding(session, findingID)
  const id = newUUID()
  const snapshot: DesignSnapshot = {
    id,
    dataVersion: id,
    name: normalizedDesignSnapshotName(file.name, file.mediaType),
    mediaType: file.mediaType,
  }
  return {
    session: updateFinding(session, findingID, (finding) => ({
      ...finding,
      designSnapshots: [...finding.designSnapshots, snapshot],
    })),
    snapshot,
  }
}

/** Renames, keeping the extension truthful; the bytes are untouched. */
export function renameDesignSnapshot(
  session: ReviewSession,
  findingID: string,
  snapshotID: string,
  name: string
): ReviewSession {
  const current = designSnapshotIn(session, findingID, snapshotID)
  return replacingSnapshot(session, findingID, {
    ...current,
    name: normalizedDesignSnapshotName(
      name,
      current.mediaType,
      splitPathExtension(current.name).extension
    ),
  })
}

/**
 * New bytes in the same place: `id` and position stay, a new `dataVersion`
 * names the bytes, and the name's extension follows the new media type.
 */
export function replaceDesignSnapshot(
  session: ReviewSession,
  findingID: string,
  snapshotID: string,
  mediaType: DesignSnapshotMediaType
): { readonly session: ReviewSession; readonly snapshot: DesignSnapshot } {
  const current = designSnapshotIn(session, findingID, snapshotID)
  const snapshot: DesignSnapshot = {
    id: current.id,
    dataVersion: newUUID(),
    name: normalizedDesignSnapshotName(current.name, mediaType),
    mediaType,
  }
  return { session: replacingSnapshot(session, findingID, snapshot), snapshot }
}

export function removeDesignSnapshot(
  session: ReviewSession,
  findingID: string,
  snapshotID: string
): ReviewSession {
  designSnapshotIn(session, findingID, snapshotID)
  return updateFinding(session, findingID, (finding) => ({
    ...finding,
    designSnapshots: finding.designSnapshots.filter(
      (snapshot) => snapshot.id !== snapshotID
    ),
  }))
}

function editableFinding(session: ReviewSession, findingID: string) {
  const item = session.tray.find((candidate) => candidate.id === findingID)
  if (item === undefined || !isEditable(item)) {
    throw new DesignSnapshotError({ kind: "findingNotEditable" })
  }
  return item.finding
}

export function designSnapshotIn(
  session: ReviewSession,
  findingID: string,
  snapshotID: string
): DesignSnapshot {
  const snapshot = editableFinding(session, findingID).designSnapshots.find(
    (candidate) => candidate.id === snapshotID
  )
  if (snapshot === undefined) {
    throw new DesignSnapshotError({ kind: "snapshotNotFound" })
  }
  return snapshot
}

function replacingSnapshot(
  session: ReviewSession,
  findingID: string,
  snapshot: DesignSnapshot
): ReviewSession {
  return updateFinding(session, findingID, (finding) => ({
    ...finding,
    designSnapshots: finding.designSnapshots.map((candidate) =>
      candidate.id === snapshot.id ? snapshot : candidate
    ),
  }))
}
