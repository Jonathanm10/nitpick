// The HTTP contract between server/ and web/. Types only, so web/ can import
// it without pulling in Node code. Every route but sign-in and sign-out asks
// for a live sign-in and answers 401 with `signIn` without one.
import type {
  Annotation,
  BuildIdentity,
  DesignSnapshot,
  DevicePlatform,
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
import type {
  HostVersions,
  Inspection,
  SimulatorDevice,
} from "./device/DeviceHost.ts"

export type { HostVersions, SimulatorDevice }

/** `GET /api/devices` */
export interface DevicesResponse {
  readonly devices: ReadonlyArray<SimulatorDevice>
}

/** Any API failure. */
export interface ErrorResponse {
  readonly error: string
  /**
   * `deviceNotRunning`: a capture or Inspect found its device stopped on the
   * host, so the page pauses the review. `signIn` (401): the request has no live
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

/**
 * `GET /api/sign-in`: `youTrack` signs in through YouTrack's own login, at
 * `/api/sign-in/youtrack`; `token` with a permanent token.
 */
export interface SignInMethodResponse {
  readonly method: "youTrack" | "token"
}

/** A Build as the page shows it: name plus identity, never a server path. */
export interface BuildSummary {
  /**
   * Its entry in the Build Library. Only the Build of a session opened
   * before the Library has none: it isn't in the Library.
   */
  readonly id?: string
  /** The .app's name without `.app`, or the .apk's without `.apk`. */
  readonly name: string
  readonly identity: BuildIdentity
  /** Which devices run it. */
  readonly platform: DevicePlatform
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

/** `GET /api/history`: the signed-in Reviewer's History, newest session first. */
export interface HistoryResponse {
  readonly entries: ReadonlyArray<HistoryEntry>
  /** The Reviewer asking, whose own last session the home trace shows. */
  readonly reviewer: YouTrackUser
}

/**
 * What became of one History file in `POST /api/history/import`:
 *
 * - `imported`: added to the importer's History, as filed by them.
 * - `duplicate`: their History already holds the session: the same start
 *   and the same Issue IDs.
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
  /**
   * iOS simulators, newest OS first, then by name; then Android emulators,
   * likewise.
   */
  readonly devices: ReadonlyArray<SimulatorDevice>
  /** Most recent first: the source of Recent and the preselection. */
  readonly recentDeviceUDIDs: ReadonlyArray<string>
  /** Why no Android emulator is listed, when the host can't run one. */
  readonly androidProblem?: string
  /**
   * Why iOS Builds launch without Inspect, when the host can't build its
   * library; `GET /api/session/layout` then answers `unavailable`.
   */
  readonly inspectProblem?: string
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

/**
 * A Build in the Build Library (ADR-0016), which every signed-in Reviewer
 * sees, starts a review on and may delete.
 */
export interface LibraryBuild extends BuildSummary {
  readonly id: string
  readonly uploadedBy: { readonly login: string; readonly name: string }
  /** ISO-8601. */
  readonly uploadedAt: string
  /** A Review Session is open or starting on it, so it can't be deleted. */
  readonly inUse: boolean
}

/** `GET /api/library`: every Build on the Device Host, newest upload first. */
export interface LibraryResponse {
  readonly builds: ReadonlyArray<LibraryBuild>
}

/**
 * The Reviewer's Build, with its Library id. `POST /api/build?name=<file
 * name>`, with the zip or .apk as the request body, adds it to the Library
 * for everyone and picks it. `PUT /api/build` picks a Library Build, and
 * answers 404 once it was deleted. A Build that isn't the Reviewer's yet
 * ends their open session.
 */
export interface BuildResponse {
  readonly build: BuildSummary
}

/** `PUT /api/build` */
export interface PickBuildRequest {
  readonly id: string
}

// `DELETE /api/library/:id` deletes a Build from the Library for everyone:
// 204. A review open or starting on it answers 409, saying so, as does a
// Reviewer's open session that can't be read; a Build no longer there, 404.

/** `POST /api/session`: start a Review Session, or resume the open one. */
export interface StartReviewRequest {
  readonly deviceUDID: string
  /** Ignored when a session is open: it resumes under its pinned project. */
  readonly projectID?: string
  /**
   * The Build the page shows, the open session's or the one picked; none
   * for a session's Build from before the Library. A start whose Build
   * isn't the Reviewer's any more, picked in another tab or deleted, is
   * refused before any device is claimed.
   */
  readonly buildID?: string
}

export type StartReviewResponse =
  | {
      readonly status: "started"
      /** The Build the review runs, for the page to show. */
      readonly build: BuildSummary
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
 * runs on. A stopped device answers 409 with `deviceNotRunning`.
 */
export interface DeviceStreamRequest {
  readonly deviceUDID: string
}

export interface DeviceStreamResponse {
  /** What the hub names the device by: a UDID, or an emulator's serial. */
  readonly hubDevice: string
}

/**
 * `GET /api/session/layout`: Inspect (ADR-0015), the layout of what the
 * Reviewer's device shows at the moment of the request, read from the
 * running Build each time; nothing is cached. The device is the one the
 * Reviewer's open session runs on, so the request names none. A first
 * request after a launch can take seconds, later ones well under one.
 *
 * - `ready`: the snapshot, in screen points (`LayoutSnapshot` in core).
 * - `unavailable`: Inspect can't read this device, and `reason` says why in
 *   the Reviewer's words: an Android emulator, a Device Host that can't build
 *   the library, or a Build launched without it.
 *
 * Refusals, with `error` in the Reviewer's words: 409 without an open
 * session or a device it runs on; 409 with `deviceNotRunning` when the
 * device stopped; 502 when the Build doesn't answer, as when it quit, is
 * still starting, or isn't SwiftUI's to read.
 */
export type LayoutResponse = Inspection

// Through the proxy to the hub, for an iOS simulator:
// `GET /api/device-hub/vendor/serve-sim/helper/:udid/stream.avcc` (H.264) and
// `…/stream.mjpeg`, and the input WebSocket at
// `/api/device-hub/vendor/serve-sim/helper/ws?device=:udid`. For an Android
// emulator: `POST /api/device-hub/vendor/serve-emu/webrtc/offer?device=:serial`
// and `…/webrtc/close?device=:serial` (JSON), and the input WebSocket at
// `/api/device-hub/vendor/serve-emu/ws?device=:serial`, which carries no
// video. Anything else under /api/device-hub is a 404, another method a 405,
// a request without a live sign-in a 401, and a POST or WebSocket from
// another origin a 403.
