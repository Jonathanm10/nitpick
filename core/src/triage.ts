/**
 * What kind of feedback a Finding is (glossary: Type). Always set; filed as a
 * namespaced tag, never the project's native Type field (ADR-0008).
 */
export type FindingType = "bug" | "improvement"

export const findingTypes: ReadonlyArray<FindingType> = ["bug", "improvement"]

/**
 * A Priority from the target project's own scale (glossary: Priority). A
 * Finding without one takes the project's default.
 */
export interface FindingPriority {
  /** The value's name, exactly as the project defines it. */
  readonly name: string
}

/** The project member a Finding is assigned to (glossary: Assignee). */
export interface FindingAssignee {
  /** What YouTrack's Assignee field is set by. */
  readonly login: string
  readonly fullName: string
}

/**
 * The tag a filed Finding of this Type carries, created on first use like
 * `design-review` and queried alongside it.
 */
export function findingTypeTagName(type: FindingType): string {
  return `nitpick-type:${type}`
}
