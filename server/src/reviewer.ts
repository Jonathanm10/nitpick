// One Reviewer's side of the server: the Build they uploaded, their open
// Review Session and Recent devices, and the one run at a time they may have
// going. The operations follow Sources/Nitpick/AppModel.swift's ingest,
// startReview, switchDevice and endReview.
import { createWriteStream } from "node:fs"
import { rm } from "node:fs/promises"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import {
  loadProjectSchema,
  newReviewSession,
  ShellActivity,
  verifyYouTrack,
  type Build,
  type ProjectSchema,
  type RecentDevices,
  type ReviewSession,
  type YouTrackClient,
  type YouTrackProject,
} from "@nitpick/core"
import { readBuildFromArchive, zipArchiveName } from "./buildIngestion.ts"
import type {
  DeviceHost,
  HostProblem,
  SimulatorDevice,
} from "./device/DeviceHost.ts"
import { ReviewerStore } from "./reviewerStore.ts"
import type { SubprocessRunner } from "./subprocess.ts"

/** A request the Reviewer's current state can't satisfy. */
export class ReviewRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReviewRefused"
  }
}

export interface ReviewerDependencies {
  readonly deviceHost: DeviceHost
  /** Runs the extraction of uploaded Builds. */
  readonly runner: SubprocessRunner
  /** Undefined when the server has no YouTrack connection configured. */
  readonly youTrack: YouTrackClient | undefined
}

export type HostStatus =
  | {
      readonly status: "ready"
      readonly devices: SimulatorDevice[]
      readonly recentDevices: RecentDevices
    }
  | { readonly status: "notReady"; readonly problem: HostProblem }

export type StartOutcome =
  | {
      readonly status: "started"
      readonly session: ReviewSession
      readonly device: SimulatorDevice
      readonly schema: ProjectSchema
      readonly devices: SimulatorDevice[]
      readonly recentDevices: RecentDevices
    }
  | { readonly status: "hostNotReady"; readonly problem: HostProblem }

const emptySchema: ProjectSchema = { priorities: [], assignees: [] }

export class Reviewer {
  readonly #dependencies: ReviewerDependencies
  readonly #store: ReviewerStore
  #activity = new ShellActivity()
  /**
   * A Build uploaded since the last session ended. Held in memory: a server
   * restart forgets it, as a relaunch of the Swift app did, while an open
   * session keeps its own Build on disk.
   */
  #uploadedBuild: Build | undefined

  constructor(directory: string, dependencies: ReviewerDependencies) {
    this.#dependencies = dependencies
    this.#store = new ReviewerStore(directory)
  }

  /** The Build and the open session, as a reload finds them. */
  async state(): Promise<{
    readonly build: Build | undefined
    readonly session: ReviewSession | undefined
  }> {
    const session = await this.#store.openSession()
    return { build: session?.build ?? this.#uploadedBuild, session }
  }

  async hostStatus(): Promise<HostStatus> {
    const health = await this.#dependencies.deviceHost.checkHealth()
    if (health.status === "notReady") return health
    return {
      status: "ready",
      devices: health.devices,
      recentDevices: await this.#store.recentDevices(),
    }
  }

  /**
   * Ingests an uploaded zip. A Review Session reviews exactly one Build, so
   * an accepted upload ends the open session, on disk too. A refused upload
   * throws before anything changes, and leaves no files behind.
   */
  ingest(
    upload: ReadableStream<Uint8Array> | null,
    fileName: string
  ): Promise<Build> {
    return this.#perform(async () => {
      const archiveName = zipArchiveName(fileName)
      const slot = await this.#store.newBuildSlot()
      try {
        await pipeline(
          upload === null ? Readable.from([]) : Readable.fromWeb(upload),
          createWriteStream(slot.archivePath)
        )
        const build = await readBuildFromArchive(
          this.#dependencies.runner,
          { path: slot.archivePath, name: archiveName },
          slot.buildDirectory
        )
        await this.#store.clearOpenSession()
        this.#uploadedBuild = build
        await this.#store.pruneBuilds(slot.id)
        return build
      } catch (error) {
        await rm(slot.buildDirectory, { recursive: true, force: true })
        throw error
      } finally {
        await rm(slot.archivePath, { force: true })
      }
    })
  }

  /**
   * Starts the Review Session, or resumes the open one under its pinned
   * project: re-checks the host, launches the Build, records the device in
   * Recent, reads the project's schema, and saves a new session.
   */
  start(request: {
    readonly deviceUDID: string
    readonly projectID: string | undefined
  }): Promise<StartOutcome> {
    return this.#perform(async () => {
      const open = await this.#store.openSession()
      const build = open?.build ?? this.#uploadedBuild
      if (build === undefined) {
        throw new ReviewRefused("Upload a Build before starting a review.")
      }
      // A missing Xcode or runtime shows as the host's reason before any boot.
      const health = await this.#dependencies.deviceHost.checkHealth()
      if (health.status === "notReady") {
        return { status: "hostNotReady", problem: health.problem }
      }
      const device = deviceNamed(request.deviceUDID, health.devices)
      const project = open?.project ?? (await this.#project(request.projectID))
      await this.#dependencies.deviceHost.launchBuild(build, device)
      const recentDevices = await this.#recordRecentDevice(device)
      // Non-fatal: an empty schema hides the Editor's controls, and capture
      // and filing proceed regardless (ADR-0008).
      const youTrack = this.#dependencies.youTrack
      const schema =
        youTrack === undefined
          ? emptySchema
          : await loadProjectSchema(youTrack, project)
      const session = open ?? newReviewSession({ build, project })
      if (open === undefined) await this.#store.saveOpenSession(session)
      return {
        status: "started",
        session,
        device,
        schema,
        devices: health.devices,
        recentDevices,
      }
    })
  }

  /**
   * Relaunches the session's Build on another device. The session itself is
   * untouched, and a failure leaves Recent as it was.
   */
  switchDevice(deviceUDID: string): Promise<{
    readonly device: SimulatorDevice
    readonly recentDevices: RecentDevices
  }> {
    return this.#perform(async () => {
      const open = await this.#store.openSession()
      if (open === undefined) {
        throw new ReviewRefused("There is no open review to switch devices in.")
      }
      const deviceHost = this.#dependencies.deviceHost
      const device = deviceNamed(deviceUDID, await deviceHost.devices.list())
      await deviceHost.launchBuild(open.build, device)
      return { device, recentDevices: await this.#recordRecentDevice(device) }
    })
  }

  /**
   * Ends the Review Session without filing. The Build stays loaded, and
   * History is untouched.
   */
  end(): Promise<void> {
    return this.#perform(async () => {
      const open = await this.#store.openSession()
      if (open !== undefined) this.#uploadedBuild = open.build
      await this.#store.clearOpenSession()
    })
  }

  /** One run at a time; a second one is refused with ShellBusy. */
  async #perform<T>(action: () => Promise<T>): Promise<T> {
    this.#activity = this.#activity.begin("other")
    try {
      return await action()
    } finally {
      this.#activity = this.#activity.end()
    }
  }

  /** Only after a successful launch, so a stray pick never enters Recent. */
  async #recordRecentDevice(device: SimulatorDevice): Promise<RecentDevices> {
    const recent = (await this.#store.recentDevices()).record(device.udid)
    await this.#store.saveRecentDevices(recent)
    return recent
  }

  /** The picked project, looked up on YouTrack rather than taken on trust. */
  async #project(projectID: string | undefined): Promise<YouTrackProject> {
    const youTrack = this.#dependencies.youTrack
    if (youTrack === undefined) {
      throw new ReviewRefused(
        "The nitpick server has no YouTrack connection configured, so a review can't pick a project."
      )
    }
    if (projectID === undefined) {
      throw new ReviewRefused(
        "Pick the YouTrack project the review files into."
      )
    }
    const { projects } = await verifyYouTrack(youTrack)
    const project = projects.find((candidate) => candidate.id === projectID)
    if (project === undefined) {
      throw new ReviewRefused(
        "That YouTrack project isn't visible to the server's YouTrack account."
      )
    }
    return project
  }
}

function deviceNamed(
  udid: string,
  devices: ReadonlyArray<SimulatorDevice>
): SimulatorDevice {
  const device = devices.find((candidate) => candidate.udid === udid)
  if (device === undefined) {
    throw new ReviewRefused(
      "That device is no longer on the Device Host. Pick another one."
    )
  }
  return device
}
