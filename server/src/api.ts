// The HTTP contract between server/ and web/. Types only, so web/ can import
// it without pulling in Node code. Every route but sign-in and sign-out asks
// for a live sign-in and answers 401 with `signIn` without one.
import type {
  Annotation,
  BuildIdentity,
  DesignSnapshot,
  FeedbackEnvironment,
  FeedbackKind,
  FindingAssignee,
  FindingPriority,
  FindingType,
  HistoryEntry,
  ProjectSchema,
  ReferenceDate,
  SentFeedback,
  TrayItem,
  YouTrackProject,
  YouTrackUser,
} from "@nitpick/core"
import type { HostVersions, SimulatorDevice } from "./device/DeviceHost.ts"

export type { HostVersions, SimulatorDevice }

/** `GET /api/devices` */
export interface DevicesResponse {
  readonly devices: ReadonlyArray<SimulatorDevice>
}

/** Any API failure. */
export interface ErrorResponse {
  readonly error: string
  /**
   * `deviceNotRunning`: the capture found its device stopped on the host, so
   * the page pauses the review. `signIn` (401): the request has no live
   * sign-in, so the page shows sign-in with the error, which says why when
   * the sign-in ended by itself.
   */
  readonly code?: "deviceNotRunning" | "signIn"
}

/** `POST /api/sign-in` takes the Reviewer's YouTrack permanent token. */
export interface SignInRequest {
  readonly token: string
}

/**
 * `POST /api/sign-in` and `GET /api/me`: who is signed in. Sign-in sets the
 * HttpOnly cookie every other route asks for; a refused token answers 401
 * or 400 without a code, and YouTrack out of reach 502.
 * `POST /api/sign-out` ends the sign-in and answers 204.
 */
export interface SignedInResponse {
  readonly reviewer: YouTrackUser
}

/** A Build as the page shows it: name plus identity, never a server path. */
export interface BuildSummary {
  /** The .app's name without `.app`. */
  readonly name: string
  readonly identity: BuildIdentity
}

/** The open Review Session: everything but its Build's server path. */
export interface SessionSummary {
  readonly project: YouTrackProject
  readonly startedAt: ReferenceDate
  readonly designReference?: string
  /** In capture order; the Tray shows it newest first. */
  readonly tray: ReadonlyArray<TrayItem>
}

/**
 * `GET /api/review`: the Reviewer's Build and open session. The session's
 * Build is the Build: a new one ends the session.
 */
export interface ReviewStateResponse {
  readonly build?: BuildSummary
  readonly session?: SessionSummary
  readonly filing: FilingStatus
}

/**
 * Where the Reviewer's File all stands. It runs on the server, so the page
 * follows it through `GET /api/review`, across a reload too.
 *
 * - `running`: the ladder is climbing; the session on disk gains each mark.
 * - `failed`: the run stopped. The error stays for the partly filed rows
 *   until the next run, or until the session ends.
 * - `filed`: the session just filed, as the History entry it recorded,
 *   held until Done or the next Build (ADR-0007). Picked by identity, never
 *   as History's newest entry, which may be another Reviewer's.
 *
 * Both endings carry the triage fields the run had to drop, if any.
 */
export type FilingStatus =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | {
      readonly status: "failed"
      readonly error: string
      readonly droppedFieldNotice?: string
    }
  | {
      readonly status: "filed"
      readonly result: HistoryEntry
      readonly droppedFieldNotice?: string
    }

/**
 * `POST /api/session/filing` starts File all and answers 202 at once; a run
 * already going answers 409.
 */
export interface FilingResponse {
  readonly filing: FilingStatus
}

// `DELETE /api/filing-result` is Done on the filing result: 204.

/** `GET /api/history`: the shared History, newest session first. */
export interface HistoryResponse {
  readonly entries: ReadonlyArray<HistoryEntry>
  /** The Reviewer asking, whose own last session the home trace shows. */
  readonly reviewer: YouTrackUser
}

/**
 * What became of one History file in `POST /api/history/import`:
 *
 * - `imported`: added to the shared History, as filed by the importer.
 * - `duplicate`: History already holds the session: the same start and the
 *   same Issue IDs.
 * - `openSession`: an open Review Session, never imported: it's filed or
 *   ended in the Swift app first.
 * - `refused`: not a schema v1 History file; `error` says why.
 *
 * `file` is the chosen file's name, or `<zip> › <path inside>`.
 */
export type HistoryImportResult =
  | { readonly file: string; readonly outcome: "imported" | "duplicate" }
  | { readonly file: string; readonly outcome: "openSession" }
  | {
      readonly file: string
      readonly outcome: "refused"
      readonly error: string
    }

/**
 * `POST /api/history/import`, as multipart/form-data with one `files` part
 * per chosen file: the Swift app's History files, or a zip of its history
 * folder. One result per History file, in the order chosen.
 */
export interface HistoryImportResponse {
  readonly results: ReadonlyArray<HistoryImportResult>
}

/** `GET /api/feedback/environment`: the Environment lines only the server knows. */
export interface FeedbackEnvironmentResponse {
  readonly server: string
  readonly deviceHost: HostVersions
}

/**
 * `POST /api/feedback`, as multipart/form-data: a `feedback` part holding
 * this JSON, and an optional `image` part, a PNG or JPEG.
 */
export interface FeedbackRequest {
  readonly kind: FeedbackKind
  readonly title: string
  readonly description: string
  /** The lines the dialog showed, sent as they were shown. */
  readonly environment: FeedbackEnvironment
  /** Drawn into the image when it is sent; ignored without one. */
  readonly imageAnnotations?: ReadonlyArray<Annotation>
}

export interface FeedbackResponse {
  readonly sent: SentFeedback
}

/** The devices the host can run, with the Reviewer's Recent devices. */
export interface ReadyHost {
  readonly status: "ready"
  /** iOS devices, newest OS first, then by name. */
  readonly devices: ReadonlyArray<SimulatorDevice>
  /** Most recent first: the source of Recent and the preselection. */
  readonly recentDeviceUDIDs: ReadonlyArray<string>
}

/** The Device Host can't run a review; `reason` says why. */
export interface HostNotReady {
  readonly status: "notReady"
  readonly reason: string
}

/** `GET /api/host`: the Device Host's health check. */
export type HostResponse = ReadyHost | HostNotReady

/** `GET /api/projects`: the projects the signed-in Reviewer sees. */
export interface ProjectsResponse {
  readonly projects: ReadonlyArray<YouTrackProject>
}

/** `POST /api/build?name=<file name>`, with the zip as the request body. */
export interface BuildResponse {
  readonly build: BuildSummary
}

/** `POST /api/session`: start a Review Session, or resume the open one. */
export interface StartReviewRequest {
  readonly deviceUDID: string
  /** Ignored when a session is open: it resumes under its pinned project. */
  readonly projectID?: string
}

export type StartReviewResponse =
  | {
      readonly status: "started"
      readonly session: SessionSummary
      /** The device the Build now runs on. */
      readonly device: SimulatorDevice
      /** The project's Priority scale and Assignees, read once per start. */
      readonly schema: ProjectSchema
      readonly host: ReadyHost
    }
  | HostNotReady

/** `PUT /api/session/device`: relaunch the session's Build elsewhere. */
export interface SwitchDeviceRequest {
  readonly deviceUDID: string
}

export interface SwitchDeviceResponse {
  readonly device: SimulatorDevice
  readonly recentDeviceUDIDs: ReadonlyArray<string>
}

// `DELETE /api/session` ends the Review Session without filing: 204.

/** `PATCH /api/session`: 204. Null or blank clears the Design Reference. */
export interface SessionPatch {
  readonly designReference?: string | null
}

/** `POST /api/session/captures`: capture the device the Build runs on. */
export interface CaptureRequest {
  readonly deviceUDID: string
}

/** The new Finding, last in the Tray. */
export interface CaptureResponse {
  readonly item: TrayItem
}

// `GET /api/session/findings/:id/capture`: the capture's PNG, as simctl took it.

/**
 * `PATCH /api/session/findings/:id`: 204. Only the fields named change; null
 * clears an optional one. A Finding filing has touched answers 409, one no
 * longer in the Tray 404.
 */
export interface FindingPatch {
  readonly summary?: string
  readonly description?: string
  readonly type?: FindingType
  readonly priority?: FindingPriority | null
  readonly assignee?: FindingAssignee | null
  readonly designReference?: string | null
  readonly annotations?: ReadonlyArray<Annotation>
}

// `DELETE /api/session/findings/:id` discards an editable Finding: 204.

/**
 * `POST /api/session/findings/:id/design-snapshots?name=<file name>` adds
 * one, and `PUT …/design-snapshots/:snapshotID?name=<file name>` replaces
 * one's bytes, with the image as the request body. `PATCH
 * …/design-snapshots/:snapshotID` renames, with a `DesignSnapshotRename`.
 * All three answer the snapshot as stored; `DELETE` removes one: 204.
 */
export interface DesignSnapshotResponse {
  readonly snapshot: DesignSnapshot
}

export interface DesignSnapshotRename {
  readonly name: string
}

// `GET /api/session/findings/:id/design-snapshot-data/:dataVersion`: the
// bytes a Design Snapshot's dataVersion names.

/**
 * `POST /api/device-stream`: starts streaming the booted device the Build
 * runs on: 204. A stopped device answers 409 with `deviceNotRunning`.
 */
export interface DeviceStreamRequest {
  readonly deviceUDID: string
}

// `GET /api/device-hub/vendor/serve-sim/helper/:udid/stream.avcc` (H.264) and
// `…/stream.mjpeg`, and the input WebSocket at
// `/api/device-hub/vendor/serve-sim/helper/ws?device=:udid`, go to the hub
// through the proxy. Anything else under /api/device-hub is a 404, any method
// but GET a 405, and a request without a live sign-in a 401.
