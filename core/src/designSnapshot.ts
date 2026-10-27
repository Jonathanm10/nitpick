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
