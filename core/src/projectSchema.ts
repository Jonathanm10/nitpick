// The triage options a project offers, ported from
// Sources/NitpickCore/ProjectSchema.swift: read once at session start, where
// the Build and project are fixed (ADR-0008), and held for the session, never
// stored per Finding.
import type { FindingAssignee, FindingPriority } from "./triage.ts"
import {
  optionalArray,
  optionalObject,
  optionalString,
  payloadArray,
  payloadObject,
  type PayloadObject,
} from "./youTrackPayload.ts"
import type { YouTrackClient, YouTrackProject } from "./youtrack.ts"

export interface ProjectSchema {
  /**
   * The project's Priority scale, in its own order. Empty when the project
   * has no Priority field or the read failed, which hides the control.
   */
  readonly priorities: ReadonlyArray<FindingPriority>
  /** Assignable users. Empty when there are none or the read failed. */
  readonly assignees: ReadonlyArray<FindingAssignee>
}

/**
 * Reads the project's Priority scale and assignable users. Never fails:
 * offline, no permission, no Priority field or no assignable users all give
 * an empty schema, so the Review Session still starts and the Editor hides
 * the control. Type is nitpick's own and never read here.
 */
export async function loadProjectSchema(
  youTrack: YouTrackClient,
  project: YouTrackProject
): Promise<ProjectSchema> {
  try {
    const fields = await youTrack.request({
      path: `api/admin/projects/${project.id}/customFields`,
      query:
        "fields=field(name),bundle(values(name),aggregatedUsers(login,fullName))&$top=100",
      decode: (json) => payloadArray(json).map(customField),
    })
    const named = (name: string) =>
      fields.find((field) => field.name === name)?.bundle
    return {
      priorities: (named("Priority")?.values ?? []).flatMap((value) =>
        value === undefined ? [] : [{ name: value }]
      ),
      assignees: (named("Assignee")?.users ?? []).flatMap((user) =>
        user.login === undefined
          ? []
          : [{ login: user.login, fullName: user.fullName ?? user.login }]
      ),
    }
  } catch {
    return { priorities: [], assignees: [] }
  }
}

/**
 * The subset of `ProjectCustomField` the read uses: the field's name and, for
 * a bundle-backed field, its values (an enum bundle) or its users (a user
 * bundle). Everything is optional, so a partial payload reads as empty.
 */
interface CustomField {
  readonly name?: string
  readonly bundle?: {
    readonly values?: ReadonlyArray<string | undefined>
    readonly users?: ReadonlyArray<{
      readonly login?: string
      readonly fullName?: string
    }>
  }
}

function customField(json: unknown): CustomField {
  const payload = payloadObject(json)
  const field = optionalObject(payload, "field")
  const bundle = optionalObject(payload, "bundle")
  return {
    name: field === undefined ? undefined : optionalString(field, "name"),
    bundle:
      bundle === undefined
        ? undefined
        : {
            values: optionalArray(bundle, "values")?.map((value) =>
              optionalString(payloadObject(value), "name")
            ),
            users: optionalArray(bundle, "aggregatedUsers")?.map(user),
          },
  }
}

function user(json: unknown): { login?: string; fullName?: string } {
  const payload: PayloadObject = payloadObject(json)
  return {
    login: optionalString(payload, "login"),
    fullName: optionalString(payload, "fullName"),
  }
}
