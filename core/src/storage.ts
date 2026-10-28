// The schema v1 JSON of Sources/NitpickCore/SessionPersistence.swift: the open
// session's manifest and one History entry, as the Swift app writes them. The
// server stores both in this format, so a Swift History file imports as is.
// Image bytes are not in the JSON: a manifest names each capture by its tray
// item's id and each Design Snapshot by its dataVersion.
import {
  annotationColors,
  type Annotation,
  type Point,
  type Rect,
} from "./annotation.ts"
import type { Build, BuildIdentity } from "./build.ts"
import {
  designSnapshotMediaTypes,
  type DesignSnapshot,
} from "./designSnapshot.ts"
import type { DeviceContext } from "./deviceContext.ts"
import type { FiledFinding, HistoryEntry } from "./history.ts"
import type {
  FilingProgress,
  ReviewSession,
  TrayItem,
} from "./reviewSession.ts"
import { encodeSwiftJSON, type SwiftJSONValue } from "./swiftJSON.ts"
import { findingTypes } from "./triage.ts"
import { parseUUID } from "./uuid.ts"
import type { FiledIssue, YouTrackProject, YouTrackUser } from "./youtrack.ts"

/**
 * Bumped on any incompatible change to the stored shapes. A reader seeing a
 * version it doesn't know refuses loudly instead of guessing.
 */
export const storageSchemaVersion = 1

/** A stored file written by a schema this build doesn't read. */
export class UnsupportedStoredSchema extends Error {
  readonly version: number

  constructor(version: number) {
    super(
      `This review data was saved by a newer version of nitpick (schema ${version}). Update nitpick to open it.`
    )
    this.name = "UnsupportedStoredSchema"
    this.version = version
  }
}

/** A stored file that isn't JSON, or not in the schema v1 shape. */
export class MalformedStoredData extends Error {
  constructor(problem: string) {
    super(`This review data can't be read: ${problem}.`)
    this.name = "MalformedStoredData"
  }
}

// MARK: - The open session's manifest

export function encodeStoredSession(session: ReviewSession): string {
  return encodeSwiftJSON({
    schemaVersion: storageSchemaVersion,
    build: storedBuild(session.build),
    project: storedProject(session.project),
    startedAt: session.startedAt,
    designReference: session.designReference,
    tray: session.tray.map(storedTrayItem),
  })
}

export function decodeStoredSession(json: string): ReviewSession {
  const stored = readStoredFile(json)
  return {
    build: build(stored.object("build")),
    project: project(stored.object("project")),
    startedAt: stored.number("startedAt"),
    designReference: stored.optionalString("designReference"),
    tray: stored.objects("tray", trayItem),
  }
}

function storedTrayItem(item: TrayItem): SwiftJSONValue {
  const { finding } = item
  return {
    id: item.id,
    summary: finding.summary,
    description: finding.description,
    deviceContext: storedDeviceContext(finding.deviceContext),
    annotations: finding.annotations.map(storedAnnotation),
    designReference: finding.designReference,
    designSnapshots: finding.designSnapshots.map(storedDesignSnapshot),
    filingProgress: storedFilingProgress(item.filingProgress),
    type: finding.type,
    priority: finding.priority && { name: finding.priority.name },
    assignee: finding.assignee && {
      login: finding.assignee.login,
      fullName: finding.assignee.fullName,
    },
  }
}

function trayItem(stored: StoredObject): TrayItem {
  const priority = stored.optionalObject("priority")
  const assignee = stored.optionalObject("assignee")
  return {
    id: stored.uuid("id"),
    finding: {
      summary: stored.string("summary"),
      description: stored.string("description"),
      deviceContext: deviceContext(stored.object("deviceContext")),
      annotations: stored.objects("annotations", annotation),
      designReference: stored.optionalString("designReference"),
      // Absent in manifests from before Design Snapshots shipped.
      designSnapshots: stored.has("designSnapshots")
        ? stored.objects("designSnapshots", designSnapshot)
        : [],
      // Absent in manifests from before Type shipped, which meant Bug.
      type: stored.has("type") ? stored.oneOf("type", findingTypes) : "bug",
      priority: priority && { name: priority.string("name") },
      assignee: assignee && {
        login: assignee.string("login"),
        fullName: assignee.string("fullName"),
      },
    },
    filingProgress: filingProgress(stored.object("filingProgress")),
  }
}

// Swift writes an enum case as an object keyed by the case name; a payload
// without labels is `_0`.
function storedFilingProgress(progress: FilingProgress): SwiftJSONValue {
  switch (progress.state) {
    case "notStarted":
      return { notStarted: {} }
    case "filed":
      return { filed: { _0: storedFiledIssue(progress.issue) } }
    default:
      return {
        [progress.state]: {
          issueID: progress.issueID,
          idReadable: progress.idReadable,
        },
      }
  }
}

function filingProgress(stored: StoredObject): FilingProgress {
  const { name, payload } = stored.swiftCase()
  switch (name) {
    case "notStarted":
      return { state: "notStarted" }
    case "issueCreated":
    case "attachmentsUploaded":
    case "reviewTagged":
      return {
        state: name,
        issueID: payload.string("issueID"),
        idReadable: payload.string("idReadable"),
      }
    case "filed":
      return { state: "filed", issue: filedIssue(payload.object("_0")) }
    default:
      return stored.fail(`has the unknown case ${JSON.stringify(name)}`)
  }
}

function storedAnnotation(annotation: Annotation): SwiftJSONValue {
  return { color: annotation.color, shape: storedShape(annotation) }
}

function storedShape(annotation: Annotation): SwiftJSONValue {
  switch (annotation.kind) {
    case "pen":
      return { pen: { points: annotation.points.map(storedPoint) } }
    case "arrow":
      return {
        arrow: {
          from: storedPoint(annotation.from),
          to: storedPoint(annotation.to),
        },
      }
    case "rectangle":
      return { rectangle: { _0: storedRect(annotation.rect) } }
    case "label":
      return {
        label: { _0: annotation.text, at: storedPoint(annotation.at) },
      }
  }
}

function annotation(stored: StoredObject): Annotation {
  const color = stored.oneOf("color", annotationColors)
  const shape = stored.object("shape")
  const { name, payload } = shape.swiftCase()
  switch (name) {
    case "pen":
      return { kind: "pen", color, points: payload.array("points", point) }
    case "arrow":
      return {
        kind: "arrow",
        color,
        from: payload.read("from", point),
        to: payload.read("to", point),
      }
    case "rectangle":
      return { kind: "rectangle", color, rect: payload.read("_0", rect) }
    case "label":
      return {
        kind: "label",
        color,
        text: payload.string("_0"),
        at: payload.read("at", point),
      }
    default:
      return shape.fail(`has the unknown case ${JSON.stringify(name)}`)
  }
}

// CGPoint is `[x, y]`; CGRect is `[[x, y], [width, height]]`.
function storedPoint(point: Point): SwiftJSONValue {
  return [point.x, point.y]
}

function point(value: unknown, path: string): Point {
  const [x, y] = numberPair(value, path)
  return { x, y }
}

function storedRect(rect: Rect): SwiftJSONValue {
  return [
    [rect.x, rect.y],
    [rect.width, rect.height],
  ]
}

function rect(value: unknown, path: string): Rect {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new MalformedStoredData(`${path} is not a rectangle`)
  }
  const [x, y] = numberPair(value[0], `${path}[0]`)
  const [width, height] = numberPair(value[1], `${path}[1]`)
  return { x, y, width, height }
}

function numberPair(value: unknown, path: string): [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((element) => typeof element === "number")
  ) {
    throw new MalformedStoredData(`${path} is not a pair of numbers`)
  }
  return [value[0], value[1]]
}

function storedDesignSnapshot(snapshot: DesignSnapshot): SwiftJSONValue {
  return {
    id: snapshot.id,
    dataVersion: snapshot.dataVersion,
    name: snapshot.name,
    mediaType: snapshot.mediaType,
  }
}

function designSnapshot(stored: StoredObject): DesignSnapshot {
  const id = stored.uuid("id")
  return {
    id,
    // Absent in manifests from before Replace minted versions: those named
    // the file by `id`, a snapshot's first version.
    dataVersion: stored.has("dataVersion") ? stored.uuid("dataVersion") : id,
    name: stored.string("name"),
    mediaType: stored.oneOf("mediaType", designSnapshotMediaTypes),
  }
}

// MARK: - A History entry

export function encodeStoredHistoryEntry(entry: HistoryEntry): string {
  return encodeSwiftJSON({
    schemaVersion: storageSchemaVersion,
    build: storedBuildIdentity(entry.build),
    project: storedProject(entry.project),
    startedAt: entry.startedAt,
    findings: entry.findings.map(storedFiledFinding),
    // The server's own addition: optional and ignored by a schema v1 reader,
    // so the Swift app's files and the server's stay one schema.
    filedBy: entry.filedBy && storedUser(entry.filedBy),
  })
}

export function decodeStoredHistoryEntry(json: string): HistoryEntry {
  const stored = readStoredFile(json)
  const filedBy = stored.optionalObject("filedBy")
  const entry: HistoryEntry = {
    build: buildIdentity(stored.object("build")),
    project: project(stored.object("project")),
    startedAt: stored.number("startedAt"),
    findings: stored.objects("findings", filedFinding),
  }
  return filedBy === undefined ? entry : { ...entry, filedBy: user(filedBy) }
}

function storedFiledFinding(finding: FiledFinding): SwiftJSONValue {
  return {
    summary: finding.summary,
    description: finding.description,
    deviceContext: storedDeviceContext(finding.deviceContext),
    designReference: finding.designReference,
    issue: storedFiledIssue(finding.issue),
  }
}

function filedFinding(stored: StoredObject): FiledFinding {
  return {
    summary: stored.string("summary"),
    description: stored.string("description"),
    deviceContext: deviceContext(stored.object("deviceContext")),
    designReference: stored.optionalString("designReference"),
    issue: filedIssue(stored.object("issue")),
  }
}

// MARK: - Shared shapes

function storedBuild(build: Build): SwiftJSONValue {
  return {
    identity: storedBuildIdentity(build.identity),
    appBundleURL: build.appBundleURL,
  }
}

function build(stored: StoredObject): Build {
  return {
    identity: buildIdentity(stored.object("identity")),
    appBundleURL: stored.string("appBundleURL"),
  }
}

function storedBuildIdentity(identity: BuildIdentity): SwiftJSONValue {
  return {
    bundleID: identity.bundleID,
    version: identity.version,
    buildNumber: identity.buildNumber,
  }
}

function buildIdentity(stored: StoredObject): BuildIdentity {
  return {
    bundleID: stored.string("bundleID"),
    version: stored.string("version"),
    buildNumber: stored.string("buildNumber"),
  }
}

function storedProject(project: YouTrackProject): SwiftJSONValue {
  return { id: project.id, shortName: project.shortName, name: project.name }
}

function project(stored: StoredObject): YouTrackProject {
  return {
    id: stored.string("id"),
    shortName: stored.string("shortName"),
    name: stored.string("name"),
  }
}

function storedUser(user: YouTrackUser): SwiftJSONValue {
  return { login: user.login, fullName: user.fullName }
}

function user(stored: StoredObject): YouTrackUser {
  return { login: stored.string("login"), fullName: stored.string("fullName") }
}

function storedDeviceContext(context: DeviceContext): SwiftJSONValue {
  return {
    deviceModel: context.deviceModel,
    osName: context.osName,
    accessibilitySettings: context.accessibilitySettings,
  }
}

function deviceContext(stored: StoredObject): DeviceContext {
  return {
    deviceModel: stored.string("deviceModel"),
    osName: stored.string("osName"),
    accessibilitySettings: stored.array("accessibilitySettings", expectString),
  }
}

function storedFiledIssue(issue: FiledIssue): SwiftJSONValue {
  return { idReadable: issue.idReadable, url: issue.url }
}

function filedIssue(stored: StoredObject): FiledIssue {
  return { idReadable: stored.string("idReadable"), url: stored.string("url") }
}

// MARK: - Reading

/**
 * Parses a stored file and checks its schema version before its shape, so a
 * newer file is refused as newer even when its shape changed. Swift decoded
 * the whole file first.
 */
function readStoredFile(json: string): StoredObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new MalformedStoredData("it is not JSON")
  }
  const stored = StoredObject.of(parsed, "")
  const version = stored.number("schemaVersion")
  if (!Number.isInteger(version)) {
    stored.fail("has a schemaVersion that is not a whole number")
  }
  if (version !== storageSchemaVersion)
    throw new UnsupportedStoredSchema(version)
  return stored
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new MalformedStoredData(`${path} is not a string`)
  }
  return value
}

/**
 * A JSON object read as Swift's synthesized Decodable reads it: a key that is
 * absent or null is missing, unknown keys are ignored, and every problem
 * names where it is.
 */
class StoredObject {
  readonly fields: Readonly<Record<string, unknown>>
  readonly path: string

  private constructor(fields: Record<string, unknown>, path: string) {
    this.fields = fields
    this.path = path
  }

  static of(value: unknown, path: string): StoredObject {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new MalformedStoredData(`${path || "the file"} is not an object`)
    }
    return new StoredObject(value as Record<string, unknown>, path)
  }

  fail(problem: string): never {
    throw new MalformedStoredData(`${this.path || "the file"} ${problem}`)
  }

  has(key: string): boolean {
    return Object.hasOwn(this.fields, key) && this.fields[key] !== null
  }

  read<T>(key: string, parse: (value: unknown, path: string) => T): T {
    const path = this.pathTo(key)
    if (!this.has(key)) throw new MalformedStoredData(`${path} is missing`)
    return parse(this.fields[key], path)
  }

  string(key: string): string {
    return this.read(key, expectString)
  }

  optionalString(key: string): string | undefined {
    return this.has(key) ? this.string(key) : undefined
  }

  number(key: string): number {
    return this.read(key, (value, path) => {
      if (typeof value !== "number") {
        throw new MalformedStoredData(`${path} is not a number`)
      }
      return value
    })
  }

  uuid(key: string): string {
    return this.read(key, (value, path) => {
      const uuid = parseUUID(expectString(value, path))
      if (uuid === undefined) {
        throw new MalformedStoredData(`${path} is not a UUID`)
      }
      return uuid
    })
  }

  oneOf<T extends string>(key: string, allowed: ReadonlyArray<T>): T {
    return this.read(key, (value, path) => {
      if (!allowed.includes(value as T)) {
        throw new MalformedStoredData(
          `${path} is not one of ${allowed.join(", ")}`
        )
      }
      return value as T
    })
  }

  object(key: string): StoredObject {
    return this.read(key, StoredObject.of)
  }

  optionalObject(key: string): StoredObject | undefined {
    return this.has(key) ? this.object(key) : undefined
  }

  array<T>(key: string, parse: (value: unknown, path: string) => T): T[] {
    return this.read(key, (value, path) => {
      if (!Array.isArray(value)) {
        throw new MalformedStoredData(`${path} is not an array`)
      }
      return value.map((element, index) => parse(element, `${path}[${index}]`))
    })
  }

  objects<T>(key: string, parse: (stored: StoredObject) => T): T[] {
    return this.array(key, (value, path) => parse(StoredObject.of(value, path)))
  }

  /** An enum case as Swift writes it: one key, the case, over its payload. */
  swiftCase(): { name: string; payload: StoredObject } {
    const names = Object.keys(this.fields)
    if (names.length !== 1) this.fail("does not hold exactly one case")
    const [name] = names
    return { name, payload: this.object(name) }
  }

  private pathTo(key: string): string {
    return this.path === "" ? key : `${this.path}.${key}`
  }
}
