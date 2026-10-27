// A Reviewer's report about nitpick itself, ported from
// Sources/NitpickCore/Feedback.swift: sent as one Issue to the NIT project,
// tagged `nitpick-feedback:<kind>`, with an Environment section and an
// optional image. Never part of a Review Session or History.
import type { Annotation } from "./annotation.ts"
import type { BuildIdentity } from "./build.ts"
import type { Flatten } from "./issueFiling.ts"
import { isBlank, trimWhitespaceAndNewlines } from "./text.ts"
import {
  applyTag,
  attach,
  createIssue,
  tagID,
  type CreatedIssue,
} from "./youTrackIssueAPI.ts"
import { payloadObject, requiredString } from "./youTrackPayload.ts"
import {
  issueURL,
  YouTrackError,
  type YouTrackClient,
  type YouTrackProject,
} from "./youtrack.ts"

export type FeedbackKind = "bug" | "improvement"

export function feedbackTagName(kind: FeedbackKind): string {
  return `nitpick-feedback:${kind}`
}

export const feedbackProjectShortName = "NIT"

const feedbackImageFileName = "nitpick-window.png"

/** The versions in play, sent as the Issue's Environment section. */
export interface FeedbackEnvironment {
  readonly nitpick: string
  readonly macOS: string
  readonly xcode: string
  /** The open Review Session's Build. */
  readonly build?: string
  /** Where the open Review Session captures from. */
  readonly captureSource?: string
}

/** The open Review Session's Build, and the device it runs on. */
export interface FeedbackReviewContext {
  readonly build: BuildIdentity
  /** The host app's display name, e.g. "Simulator". */
  readonly hostName?: string
  readonly device?: { readonly name: string; readonly osName: string }
}

const unknown = "unknown"

/**
 * The Environment from what could be read: a missing or blank version is
 * sent as "unknown", and Build and Capture Source come only with a Review
 * Session.
 */
export function feedbackEnvironment(read: {
  readonly nitpickVersion?: string
  readonly nitpickBuild?: string
  readonly macOS?: string
  readonly xcode?: string
  readonly review?: FeedbackReviewContext
}): FeedbackEnvironment {
  const version = known(read.nitpickVersion)
  const build = known(read.nitpickBuild)
  const environment = {
    nitpick:
      version === undefined || build === undefined
        ? unknown
        : `${version} (${build})`,
    macOS: known(read.macOS) ?? unknown,
    xcode: known(read.xcode) ?? unknown,
  }
  const { review } = read
  if (review === undefined) return environment
  const { bundleID, version: appVersion, buildNumber } = review.build
  return {
    ...environment,
    build: `${bundleID} ${appVersion} (${buildNumber})`,
    captureSource:
      review.device === undefined
        ? "Simulator (not running)"
        : `${review.hostName ?? "Simulator"} — ${review.device.name}, ${review.device.osName}`,
  }
}

function known(value: string | undefined): string | undefined {
  return value === undefined || isBlank(value) ? undefined : value
}

export interface EnvironmentLine {
  readonly label: string
  readonly value: string
}

/** Fixed labels in a fixed order, each value on one line. */
export function environmentLines(
  environment: FeedbackEnvironment
): EnvironmentLine[] {
  const lines: [string, string | undefined][] = [
    ["Nitpick", environment.nitpick],
    ["macOS", environment.macOS],
    ["Xcode", environment.xcode],
    ["Build", environment.build],
    ["Capture Source", environment.captureSource],
  ]
  return lines.flatMap(([label, value]) =>
    value === undefined ? [] : [{ label, value: singleLine(value) }]
  )
}

/**
 * Swift splits on `Character.isNewline`, where CR LF is one Character, so it
 * becomes one space.
 */
function singleLine(value: string): string {
  return value.split(/\r\n|[\n\v\f\r\u0085\u2028\u2029]/).join(" ")
}

export interface Feedback {
  readonly kind: FeedbackKind
  readonly title: string
  readonly description: string
  readonly environment: FeedbackEnvironment
  /** The clean image; its Annotations are flattened in only when sent. */
  readonly imagePNG?: Uint8Array
  readonly imageAnnotations?: ReadonlyArray<Annotation>
}

/** The Issue summary; sending refuses an empty one. */
export function feedbackSummary(feedback: Feedback): string {
  return trimWhitespaceAndNewlines(feedback.title)
}

/** Whether closing without sending would lose something the Reviewer wrote. */
export function feedbackHasText(feedback: Feedback): boolean {
  return !isBlank(feedback.title) || !isBlank(feedback.description)
}

/** The Issue description: the Reviewer's text, then the Environment. */
export function feedbackDescription(feedback: Feedback): string {
  const text = trimWhitespaceAndNewlines(feedback.description)
  const environment = [
    "## Environment",
    ...environmentLines(feedback.environment).map(
      ({ label, value }) => `- ${label}: ${value}`
    ),
  ].join("\n")
  return text === "" ? environment : `${text}\n\n${environment}`
}

export interface SentFeedback {
  readonly idReadable: string
  readonly url: string
  /** What failed after the Issue existed: a retry would create a second. */
  readonly warnings: ReadonlyArray<string>
}

/**
 * Sends the Feedback as one Issue. Once the Issue exists, a failed tag or
 * image upload becomes a warning instead of an error, since the Reviewer's
 * only recourse, a retry, would create a second Issue. A create whose
 * response is lost still throws, so that retry can duplicate; Finding filing
 * shares the limit.
 */
export async function sendFeedback(
  feedback: Feedback,
  sending: { readonly youTrack: YouTrackClient; readonly flatten: Flatten }
): Promise<SentFeedback> {
  const summary = feedbackSummary(feedback)
  if (summary === "") throw new YouTrackError({ kind: "feedbackTitleRequired" })
  const { youTrack } = sending

  const project = await feedbackProject(youTrack)
  const tagName = feedbackTagName(feedback.kind)
  const tag = await tagID(youTrack, tagName)
  const created: CreatedIssue = await createIssue(youTrack, {
    project,
    summary,
    description: feedbackDescription(feedback),
  })

  const warnings: string[] = []
  try {
    await applyTag(youTrack, tag, created.id, tagName)
  } catch {
    warnings.push(`The ${tagName} tag could not be applied.`)
  }
  if (feedback.imagePNG !== undefined) {
    try {
      const image = await sending.flatten(
        feedback.imagePNG,
        feedback.imageAnnotations ?? []
      )
      await attach(
        youTrack,
        [
          {
            fileName: feedbackImageFileName,
            contentType: "image/png",
            data: image,
          },
        ],
        created.id,
        "attach the window image"
      )
    } catch {
      warnings.push("The window image could not be attached.")
    }
  }
  return {
    idReadable: created.idReadable,
    url: issueURL(youTrack.credentials.instanceURL, created.idReadable),
    warnings,
  }
}

/** Looked up before the tag, so an unreadable NIT leaves no tag behind. */
async function feedbackProject(
  youTrack: YouTrackClient
): Promise<YouTrackProject> {
  const shortName = feedbackProjectShortName
  try {
    return await youTrack.request({
      path: `api/admin/projects/${shortName}`,
      query: "fields=id,name",
      deniedAction: `read the ${shortName} project`,
      decode: (json) => {
        const project = payloadObject(json)
        return {
          id: requiredString(project, "id"),
          shortName,
          name: requiredString(project, "name"),
        }
      },
    })
  } catch (error) {
    if (
      error instanceof YouTrackError &&
      error.failure.kind === "unexpectedResponse" &&
      error.failure.statusCode === 404
    ) {
      throw new YouTrackError({ kind: "projectNotFound", shortName })
    }
    throw error
  }
}
