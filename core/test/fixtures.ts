// The Swift suite's shared values: IssueFilingTests.session and .finding, and
// the YouTrack stubs and request shapes IssueFilingTests and
// SessionTrayScenarioTests share.
//
// Swift's filing tests first connect, which sends two requests, and then
// assert from `sentRequests.dropFirst(2)`. Filing here takes credentials that
// are already verified, so the same assertions start at index 0.
import type { Annotation } from "../src/annotation.ts"
import { referenceDate } from "../src/date.ts"
import type { Filing } from "../src/issueFiling.ts"
import {
  addFinding,
  newFinding,
  newReviewSession,
  type FilingProgress,
  type Finding,
  type ReviewSession,
} from "../src/reviewSession.ts"
import type { FindingType } from "../src/triage.ts"
import {
  YouTrackClient,
  YouTrackCredentials,
  type FiledIssue,
} from "../src/youtrack.ts"
import type { HTTPRequest } from "../src/http.ts"
import type { FakeHTTPTransport } from "./FakeHTTPTransport.ts"
import { FakeFilingStore } from "./FakeFilingStore.ts"

export const session: ReviewSession = newReviewSession({
  build: {
    identity: {
      bundleID: "ch.liip.reviewme",
      version: "2.1.0",
      buildNumber: "421",
    },
    appBundleURL: "file:///tmp/ReviewMe.app/",
  },
  project: { id: "0-12", shortName: "RM", name: "Review Me" },
  startedAt: referenceDate(new Date("2026-07-04T09:15:32Z")),
})

export function finding({
  summary = "Button color is off",
  description = "The primary button is #FF0000, the design says #E64545.",
  type = "bug" as FindingType,
} = {}): Finding {
  return newFinding({
    summary,
    description,
    type,
    deviceContext: {
      deviceModel: "iPhone 17 Pro",
      osName: "iOS 26.4",
      accessibilitySettings: [],
    },
  })
}

/** The fixture session with one default Finding per summary, in order. */
export function sessionWith(summaries: ReadonlyArray<string>): ReviewSession {
  return summaries.reduce(
    (session, summary) => addFinding(session, finding({ summary })).session,
    session
  )
}

export function filedIssue(idReadable: string): FiledIssue {
  return {
    idReadable,
    url: `https://youtrack.example.com/yt/issue/${idReadable}`,
  }
}

/**
 * Advances an item's filing the way the ladder records each acknowledged
 * step, for cases about the marks rather than the ladder.
 */
export function withFilingProgress(
  session: ReviewSession,
  id: string,
  filingProgress: FilingProgress
): ReviewSession {
  return {
    ...session,
    tray: session.tray.map((item) =>
      item.id === id ? { ...item, filingProgress } : item
    ),
  }
}

/** Every mark filing can leave on an item, short of and including filed. */
export const filingMarks: ReadonlyArray<FilingProgress> = [
  { state: "issueCreated", issueID: "3-505", idReadable: "RM-421" },
  { state: "attachmentsUploaded", issueID: "3-505", idReadable: "RM-421" },
  { state: "reviewTagged", issueID: "3-505", idReadable: "RM-421" },
  { state: "filed", issue: filedIssue("RM-421") },
]

// MARK: - YouTrack

/** YouTrackConnectionTests' current user and projects. */
export const userJSON = `{"login":"vera","fullName":"Vera Baumann","$type":"Me"}`
export const projectsJSON = `[
  {"id":"0-12","name":"Review Me","shortName":"RM","$type":"Project"},
  {"id":"0-3","name":"Atlas","shortName":"ATL","$type":"Project"}
]`

export const base = "https://youtrack.example.com/yt"
export const token = "perm:designer-token"

/** A client for the verified connection the designer has after settings. */
export function youTrack(transport: FakeHTTPTransport): YouTrackClient {
  return new YouTrackClient(transport, new YouTrackCredentials(base, token))
}

/** What every YouTrack request carries. */
export const expectedHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
}

/** A capture's bytes: a PNG signature and one byte, not a decodable image. */
export const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
])

/**
 * The exact JSON body issue creation must carry: designer description, blank
 * line, metadata block; keys sorted.
 */
export const expectedIssueJSON =
  String.raw`{"description":"The primary button is #FF0000, the design says #E64545.\n\n` +
  String.raw`---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n` +
  String.raw`Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}`

export const existingTagJSON = `[{"id":"6-4","name":"design-review","$type":"Tag"}]`
export const createdIssueJSON = `{"id":"3-505","idReadable":"RM-421","$type":"Issue"}`
export const attachmentsJSON =
  `[{"id":"134-31","name":"annotated.png","$type":"IssueAttachment"},` +
  `{"id":"134-32","name":"original.png","$type":"IssueAttachment"}]`
export const appliedTagJSON = `{"id":"6-4","name":"design-review","$type":"Tag"}`
/** The `nitpick-type:bug` tag: every default Finding here is a Bug. */
export const existingTypeTagJSON = `[{"id":"6-5","name":"nitpick-type:bug","$type":"Tag"}]`
export const appliedTypeTagJSON = `{"id":"6-5","name":"nitpick-type:bug","$type":"Tag"}`

export const createdIssue421 = `{"id":"3-505","idReadable":"RM-421","$type":"Issue"}`
export const createdIssue422 = `{"id":"3-506","idReadable":"RM-422","$type":"Issue"}`
export const createdIssue423 = `{"id":"3-507","idReadable":"RM-423","$type":"Issue"}`

/**
 * The stubs one Finding's happy ladder consumes: create, attach, apply
 * design-review, apply the Type tag (ADR-0008).
 */
export function enqueueLadder(
  transport: FakeHTTPTransport,
  created: string
): void {
  transport.enqueue(created)
  transport.enqueue(attachmentsJSON)
  transport.enqueue(appliedTagJSON)
  transport.enqueue(appliedTypeTagJSON)
}

/**
 * The two tag lookups every run makes before any Issue exists: the fixed
 * design-review tag, then the Bug Type tag.
 */
export function enqueueTagLookups(transport: FakeHTTPTransport): void {
  transport.enqueue(existingTagJSON)
  transport.enqueue(existingTypeTagJSON)
}

export const urls = {
  designReviewLookup: `${base}/api/tags?fields=id,name&query=design-review&$top=100`,
  bugTypeLookup: `${base}/api/tags?fields=id,name&query=nitpick-type:bug&$top=100`,
  createIssue: `${base}/api/issues?fields=id,idReadable`,
  attachments: (issueID: string) =>
    `${base}/api/issues/${issueID}/attachments?fields=id,name`,
  tags: (issueID: string) =>
    `${base}/api/issues/${issueID}/tags?fields=id,name`,
}

// MARK: - Filing

/**
 * Flattening is the server's (Skia); core's ladder only calls it. This
 * stand-in passes an unannotated capture through, as the real one does, and
 * otherwise appends a marker naming the Annotations.
 */
export async function fakeFlatten(
  png: Uint8Array,
  annotations: ReadonlyArray<Annotation>
): Promise<Uint8Array> {
  if (annotations.length === 0) return png
  const marker = new TextEncoder().encode(`+${JSON.stringify(annotations)}`)
  const flattened = new Uint8Array(png.length + marker.length)
  flattened.set(png)
  flattened.set(marker, png.length)
  return flattened
}

export function filing(
  transport: FakeHTTPTransport,
  store: FakeFilingStore = new FakeFilingStore(pngBytes)
): Filing {
  return { youTrack: youTrack(transport), store, flatten: fakeFlatten }
}

/**
 * The exact multipart body the attachments endpoint must receive: one
 * `upload` part per file, CRLF line breaks, one closing boundary.
 */
export function multipartBody(
  boundary: string,
  files: ReadonlyArray<{ readonly fileName: string; readonly data: Uint8Array }>
): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  for (const file of files) {
    const contentType = /\.jpe?g$/i.test(file.fileName)
      ? "image/jpeg"
      : "image/png"
    parts.push(
      encoder.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="upload"; filename="${file.fileName}"\r\n` +
          `Content-Type: ${contentType}\r\n` +
          `\r\n`
      ),
      file.data,
      encoder.encode("\r\n")
    )
  }
  parts.push(encoder.encode(`--${boundary}--\r\n`))
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return body
}

/** The multipart boundary an attachments request declares. */
export function boundaryOf(request: HTTPRequest | undefined): string {
  const match = /^multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)$/.exec(
    request?.headers["Content-Type"] ?? ""
  )
  if (match === null) {
    throw new Error(`not a multipart request: ${request?.url}`)
  }
  return match[1]
}
