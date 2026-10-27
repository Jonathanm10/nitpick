// The issue endpoints Finding filing and Feedback share, ported from
// Sources/NitpickCore/YouTrackIssueAPI.swift: create an Issue, attach files,
// and resolve and apply tags.
import { concatBytes, utf8 } from "./bytes.ts"
import { encodeSwiftJSON } from "./swiftJSON.ts"
import { newUUID } from "./uuid.ts"
import {
  payloadArray,
  payloadObject,
  requiredString,
} from "./youTrackPayload.ts"
import type {
  RequestBody,
  YouTrackClient,
  YouTrackProject,
} from "./youtrack.ts"

export interface AttachmentFile {
  readonly fileName: string
  readonly contentType: string
  readonly data: Uint8Array
}

/**
 * A triage custom field on the create body: Priority by its value's name,
 * Assignee by login. `$type` names the YouTrack field kind.
 */
export type IssueCustomField =
  | {
      readonly $type: "SingleEnumIssueCustomField"
      readonly name: "Priority"
      readonly value: { readonly name: string }
    }
  | {
      readonly $type: "SingleUserIssueCustomField"
      readonly name: "Assignee"
      readonly value: { readonly login: string }
    }

/** The subset of `POST api/issues` core reads back. */
export interface CreatedIssue {
  readonly id: string
  readonly idReadable: string
}

export function createIssue(
  youTrack: YouTrackClient,
  issue: {
    readonly project: YouTrackProject
    readonly summary: string
    readonly description: string
    /**
     * Absent leaves the key out, so a Finding without triage fields files the
     * body it always did, byte for byte (ADR-0008). Feedback sends none.
     */
    readonly customFields?: ReadonlyArray<IssueCustomField>
  }
): Promise<CreatedIssue> {
  return youTrack.request({
    method: "POST",
    path: "api/issues",
    query: "fields=id,idReadable",
    body: jsonBody({
      customFields: issue.customFields,
      project: { id: issue.project.id },
      summary: issue.summary,
      description: issue.description,
    }),
    deniedAction: `create an issue in ${issue.project.name}`,
    decode: (json) => {
      const created = payloadObject(json)
      return {
        id: requiredString(created, "id"),
        idReadable: requiredString(created, "idReadable"),
      }
    },
  })
}

/** One request, one `upload` part per file, in the given order. */
export async function attach(
  youTrack: YouTrackClient,
  files: ReadonlyArray<AttachmentFile>,
  issueID: string,
  deniedAction: string
): Promise<void> {
  await youTrack.request({
    method: "POST",
    path: `api/issues/${issueID}/attachments`,
    query: "fields=id,name",
    body: attachmentsBody(files),
    deniedAction,
    decode: (json) => payloadArray(json).map(tag),
  })
}

export async function applyTag(
  youTrack: YouTrackClient,
  tagID: string,
  issueID: string,
  name: string
): Promise<void> {
  await youTrack.request({
    method: "POST",
    path: `api/issues/${issueID}/tags`,
    query: "fields=id,name",
    body: jsonBody({ id: tagID }),
    deniedAction: `apply the “${name}” tag`,
    decode: tag,
  })
}

/**
 * The tag named exactly `name`, created when missing. Callers resolve every
 * tag before any Issue exists, so a refused tag creation never leaves an
 * orphan Issue (ADR-0008).
 */
export async function tagID(
  youTrack: YouTrackClient,
  name: string
): Promise<string> {
  // `query=` filters by name on the server; the exact match drops lookalikes
  // ("design-review-old", "nitpick-type:bugfix").
  const candidates = await youTrack.request({
    path: "api/tags",
    query: `fields=id,name&query=${name}&$top=100`,
    deniedAction: "list tags",
    decode: (json) => payloadArray(json).map(tag),
  })
  const existing = candidates.find((candidate) => candidate.name === name)
  if (existing !== undefined) return existing.id
  const created = await youTrack.request({
    method: "POST",
    path: "api/tags",
    query: "fields=id,name",
    body: jsonBody({ name }),
    deniedAction: `create the “${name}” tag (it does not exist yet)`,
    decode: tag,
  })
  return created.id
}

function tag(json: unknown): { readonly id: string; readonly name: string } {
  const payload = payloadObject(json)
  return {
    id: requiredString(payload, "id"),
    name: requiredString(payload, "name"),
  }
}

/** Swift's JSONEncoder with sorted keys: byte-stable bodies. */
function jsonBody(payload: Parameters<typeof encodeSwiftJSON>[0]): RequestBody {
  return {
    contentType: "application/json",
    data: utf8(encodeSwiftJSON(payload)),
  }
}

/**
 * The multipart/form-data body YouTrack's attachments endpoint expects: one
 * `upload` part per file. Every line break is CRLF, and exactly one blank
 * line separates a part's headers from its content.
 */
function attachmentsBody(files: ReadonlyArray<AttachmentFile>): RequestBody {
  const boundary = `nitpick-${newUUID()}`
  const parts: Uint8Array[] = []
  for (const file of files) {
    parts.push(
      utf8(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="upload"; filename="${quotedFileName(file.fileName)}"\r\n` +
          `Content-Type: ${file.contentType}\r\n` +
          "\r\n"
      ),
      file.data,
      utf8("\r\n")
    )
  }
  parts.push(utf8(`--${boundary}--\r\n`))
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    data: concatBytes(parts),
  }
}

function quotedFileName(fileName: string): string {
  return fileName
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
}
