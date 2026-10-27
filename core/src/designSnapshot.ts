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
