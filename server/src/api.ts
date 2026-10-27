// The HTTP contract between server/ and web/. Types only, so web/ can import
// it without pulling in Node code.
import type {
  BuildIdentity,
  ProjectSchema,
  ReferenceDate,
  YouTrackProject,
} from "@nitpick/core"
import type { SimulatorDevice } from "./device/DeviceHost.ts"

export type { SimulatorDevice }

/** `GET /api/devices` */
export interface DevicesResponse {
  readonly devices: ReadonlyArray<SimulatorDevice>
}

/** Any API failure. */
export interface ErrorResponse {
  readonly error: string
}

/** A Build as the page shows it: name plus identity, never a server path. */
export interface BuildSummary {
  /** The .app's name without `.app`. */
  readonly name: string
  readonly identity: BuildIdentity
}

/** The open Review Session as home and the session screen show it. */
export interface SessionSummary {
  readonly project: YouTrackProject
  readonly startedAt: ReferenceDate
  readonly unfiledFindingCount: number
}

/**
 * `GET /api/review`: the Reviewer's Build and open session. The session's
 * Build is the Build: a new one ends the session.
 */
export interface ReviewStateResponse {
  readonly build?: BuildSummary
  readonly session?: SessionSummary
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

/** `GET /api/projects`: the projects the server's YouTrack account sees. */
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
