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

/**
 * The versions in play, sent as the Issue's Environment section. The Swift
 * app sent its own version and the Mac it ran on; the web app sends its own
 * build, the server's, the Reviewer's browser and the Device Host's macOS
 * and Xcode. A line is left out when its field is.
 */
export interface FeedbackEnvironment {
  /** The Swift app's version and build. */
  readonly nitpick?: string
  /** The page's build: a tab left open across a deploy runs an older one. */
  readonly webApp?: string
  readonly server?: string
  /** The Reviewer's browser and OS, e.g. "Chrome 131 on Windows". */
  readonly browser?: string
  /** The Swift app's Mac, which ran the simulator too. */
  readonly macOS?: string
  readonly xcode?: string
  readonly deviceHostMacOS?: string
  readonly deviceHostXcode?: string
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
  return {
    nitpick:
      version === undefined || build === undefined
        ? unknown
        : `${version} (${build})`,
    macOS: known(read.macOS) ?? unknown,
    xcode: known(read.xcode) ?? unknown,
    ...reviewLines(read.review),
  }
}

/**
 * The web app's Environment, by the same rules: what wasn't read is
 * "unknown", and Build and Capture Source need a Review Session.
 */
export function webFeedbackEnvironment(read: {
  readonly webApp?: string
  readonly server?: string
  readonly browser?: string
  readonly deviceHostMacOS?: string
  readonly deviceHostXcode?: string
  readonly review?: FeedbackReviewContext
}): FeedbackEnvironment {
  return {
    webApp: known(read.webApp) ?? unknown,
    server: known(read.server) ?? unknown,
    browser: known(read.browser) ?? unknown,
    deviceHostMacOS: known(read.deviceHostMacOS) ?? unknown,
    deviceHostXcode: known(read.deviceHostXcode) ?? unknown,
    ...reviewLines(read.review),
  }
}

function reviewLines(
  review: FeedbackReviewContext | undefined
): Pick<FeedbackEnvironment, "build" | "captureSource"> {
  if (review === undefined) return {}
  const { bundleID, version, buildNumber } = review.build
  return {
    build: `${bundleID} ${version} (${buildNumber})`,
    captureSource:
      review.device === undefined
        ? "Simulator (not running)"
        : `${review.hostName ?? "Simulator"} — ${review.device.name}, ${review.device.osName}`,
  }
}

function known(value: string | undefined): string | undefined {
  return value === undefined || isBlank(value) ? undefined : value
}

/**
 * A browser's name, major version and OS from its user agent, such as
 * "Edge 131 on Windows"; undefined when the browser isn't recognised.
 * Order matters: Edge and Opera also claim Chrome, and Chrome also claims
 * Safari.
 */
export function browserDescription(userAgent: string): string | undefined {
  const browsers: ReadonlyArray<readonly [string, RegExp]> = [
    ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /\bOPR\/(\d+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /\b(?:HeadlessChrome|Chrome|CriOS)\/(\d+)/],
    ["Safari", /\bVersion\/(\d+(?:\.\d+)?).*\bSafari\//],
  ]
  const systems: ReadonlyArray<readonly [string, RegExp]> = [
    ["Windows", /\bWindows\b/],
    ["iOS", /\b(?:iPhone|iPad|iPod)\b/],
    ["Android", /\bAndroid\b/],
    ["ChromeOS", /\bCrOS\b/],
    ["macOS", /\bMac OS X\b/],
    ["Linux", /\bLinux\b/],
  ]
  for (const [name, pattern] of browsers) {
    const version = pattern.exec(userAgent)?.[1]
    if (version === undefined) continue
    const system = systems.find(([, test]) => test.test(userAgent))?.[0]
    return system === undefined
      ? `${name} ${version}`
      : `${name} ${version} on ${system}`
  }
  return undefined
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
    ["Web app", environment.webApp],
    ["Server", environment.server],
    ["Browser", environment.browser],
    ["macOS", environment.macOS],
    ["Xcode", environment.xcode],
    ["Device Host macOS", environment.deviceHostMacOS],
    ["Device Host Xcode", environment.deviceHostXcode],
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
