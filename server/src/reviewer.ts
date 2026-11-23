// One Reviewer's side of the server: the Build they picked from the Build
// Library, their open Review Session and Recent devices, and the one run at a
// time they may have going. The operations follow
// Sources/Nitpick/AppModel.swift's ingest, startReview, switchDevice,
// endReview, captureScreen, the Editor's edits and fileAllFindings.
import { readFile } from "node:fs/promises"
import type { ReadableStream } from "node:stream/web"
import {
  addDesignSnapshot,
  addFinding,
  buildPlatform,
  devicePlatform,
  designSnapshotMediaType,
  deviceContextOf,
  discardFinding,
  droppedFieldNotice,
  fileAll,
  filedIssueOf,
  historyEntry,
  isEditable,
  loadProjectSchema,
  newFinding,
  newReviewSession,
  removeDesignSnapshot,
  renameDesignSnapshot,
  replaceDesignSnapshot,
  ShellActivity,
  ShellBusy,
  updateFinding,
  verifyYouTrack,
  type Build,
  type DesignSnapshot,
  type FileAllOutcome,
  type HistoryEntry,
  type ProjectSchema,
  type RecentDevices,
  type ReviewSession,
  type TrayItem,
  type YouTrackClient,
  type YouTrackProject,
  type YouTrackUser,
} from "@nitpick/core"
import { annotatedScreenshotPNG } from "./annotationFlattening.ts"
import type {
  FilingStatus,
  FindingPatch,
  HistoryImportResult,
  SessionPatch,
} from "./api.ts"
import {
  LibraryBuildNotFound,
  type BuildLibrary,
  type LibraryEntry,
  type LibraryLease,
  type Uploader,
} from "./buildLibrary.ts"
import { checkDesignSnapshotImage } from "./designSnapshotImage.ts"
import { designReference, patchedFinding } from "./findingPatch.ts"
import type {
  AndroidProblem,
  DeviceHost,
  HostProblem,
  Inspection,
  SimulatorDevice,
} from "./device/DeviceHost.ts"
import type { DeviceClaims } from "./device/deviceClaims.ts"
import { importHistory, type HistoryUpload } from "./historyImport.ts"
import type { HistoryStore } from "./historyStore.ts"
import { ReviewerStore } from "./reviewerStore.ts"
import type { SubprocessRunner } from "./subprocess.ts"

/** A request the Reviewer's current state can't satisfy. */
export class ReviewRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReviewRefused"
  }
}

/** The Finding, or its file, isn't in the open session. */
export class FindingNotFound extends Error {
  constructor() {
    super("This Finding is no longer in the Tray.")
    this.name = "FindingNotFound"
  }
}

export interface ReviewerDependencies {
  readonly deviceHost: DeviceHost
  /** Every uploaded Build, one Library for all. */
  readonly library: BuildLibrary
  /** Runs the extraction of History zips. */
  readonly runner: SubprocessRunner
  /** Every Reviewer's filed sessions, one store for all. */
  readonly history: HistoryStore
  /** Which Reviewer each device runs for, under the host's cap. */
  readonly deviceClaims: DeviceClaims
}

/** The signed-in Reviewer's YouTrack account: who files, with whose token. */
export interface YouTrackAccount {
  readonly user: YouTrackUser
  readonly youTrack: YouTrackClient
}

export type HostStatus =
  | {
      readonly status: "ready"
      readonly devices: SimulatorDevice[]
      readonly recentDevices: RecentDevices
      readonly androidProblem?: AndroidProblem
      readonly inspectProblem?: string
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
      readonly androidProblem?: AndroidProblem
      readonly inspectProblem?: string
    }
  | { readonly status: "hostNotReady"; readonly problem: HostProblem }

export class Reviewer {
  readonly #login: string
  readonly #dependencies: ReviewerDependencies
  readonly #store: ReviewerStore
  #activity = new ShellActivity()
  /**
   * Every read-modify-write of the open session runs in turn, so an edit
   * can't save over a capture, resurrect an ended session, or have a save's
   * prune delete a file another write has yet to name.
   */
  #sessionWrites: Promise<unknown> = Promise.resolve()
  /**
   * The Library id of the Build picked or uploaded since the last session
   * ended. Held in memory: a server restart forgets it, as a relaunch of the
   * Swift app did, while an open session keeps its own Build.
   */
  #selection: string | undefined
  /**
   * Whether the Builds from before the Library are gone but the open
   * session's: not yet at a server start, nor after a removal that failed.
   */
  #legacyBuildsRemoved = false
  /**
   * File all's run and its ending, in memory as AppModel held them: a
   * server restart forgets a failure (the rows say "Filing interrupted —
   * retry") and a held result (ADR-0007: a quit returns to plain home).
   */
  #filing: FilingStatus = { status: "idle" }

  constructor(
    login: string,
    directory: string,
    dependencies: ReviewerDependencies
  ) {
    this.#login = login
    this.#dependencies = dependencies
    this.#store = new ReviewerStore(directory)
  }

  /** The Build, the open session and File all, as a reload finds them. */
  async state(): Promise<{
    readonly build: Build | undefined
    readonly session: ReviewSession | undefined
    readonly filing: FilingStatus
  }> {
    const filing = this.#filing
    const session = await this.#store.openSession()
    if (!this.#legacyBuildsRemoved) {
      await this.#removeLegacyBuilds(session?.build)
    }
    return {
      build: session?.build ?? (await this.#selectedBuild()),
      session,
      filing,
    }
  }

  /**
   * The picked Build, dropped once someone deleted it from the Library. An
   * entry that can't be read is logged, shows no Build, and stays picked.
   */
  async #selectedBuild(): Promise<Build | undefined> {
    const id = this.#selection
    if (id === undefined) return undefined
    let entry: LibraryEntry | undefined
    try {
      entry = await this.#dependencies.library.get(id)
    } catch (error) {
      console.error(`The Build Library's ${id} can't be read.`, error)
      return undefined
    }
    if (entry === undefined && this.#selection === id) {
      this.#selection = undefined
    }
    return entry?.build
  }

  async hostStatus(): Promise<HostStatus> {
    const health = await this.#dependencies.deviceHost.checkHealth()
    if (health.status === "notReady") return health
    return {
      status: "ready",
      devices: health.devices,
      recentDevices: await this.#store.recentDevices(),
      androidProblem: health.androidProblem,
      inspectProblem: health.inspectProblem,
    }
  }

  /**
   * Adds an uploaded zip or .apk to the Library and picks it. A refused
   * upload throws before anything changes, and leaves no files behind; one
   * deleted from the Library before it is picked leaves the open session.
   */
  ingest(
    upload: ReadableStream<Uint8Array> | null,
    fileName: string,
    uploader: Uploader
  ): Promise<Build> {
    return this.#perform(async () => {
      const library = this.#dependencies.library
      const added = await library.add(upload, fileName, uploader)
      const build = await library.withEntry(added.id, async (entry) => {
        await this.#select(entry.id)
        return entry.build
      })
      await this.#removeLegacyBuilds(undefined)
      return build
    })
  }

  /**
   * Picks a Build from the Library. Picking the Build already theirs, the
   * open session's included, changes nothing; one deleted meanwhile is
   * LibraryBuildNotFound, and the open session stays.
   */
  pick(id: string): Promise<Build> {
    return this.#perform(async () => {
      const library = this.#dependencies.library
      const build = await library.withEntry(id, async (entry) => {
        const open = await this.#store.openSession()
        const current = open ? library.entryID(open.build) : this.#selection
        if (current !== entry.id) await this.#select(entry.id)
        return entry.build
      })
      await this.#removeLegacyBuilds(undefined)
      return build
    })
  }

  /**
   * A Review Session reviews exactly one Build, so another one ends the open
   * session, on disk too. Runs while the Library holds the Build, so a
   * delete never lands between the check that it is there and the end.
   */
  async #select(id: string): Promise<void> {
    await this.#serialized(() => this.#store.clearOpenSession())
    this.#dependencies.deviceClaims.release(this.#login)
    this.#selection = id
    // The next Build dismisses a held filing result (ADR-0007).
    this.#filing = { status: "idle" }
  }

  /**
   * Deletes what is left of the Build slots from before the Library, but
   * the one `keeping` runs. After a session's change, never part of it: a
   * failure is logged, and the next load tries again.
   */
  async #removeLegacyBuilds(keeping: Build | undefined): Promise<void> {
    try {
      await this.#store.removeLegacyBuilds(keeping)
      this.#legacyBuildsRemoved = true
    } catch (error) {
      this.#legacyBuildsRemoved = false
      console.error(
        "The Builds from before the Build Library couldn't be deleted; the next load tries again.",
        error
      )
    }
  }

  /**
   * Imports the Swift app's History files into `importer`'s History, as
   * filed by them. Not a run: the review goes on beside it.
   */
  importHistory(
    uploads: ReadonlyArray<HistoryUpload>,
    importer: YouTrackUser
  ): Promise<HistoryImportResult[]> {
    return importHistory(uploads, {
      history: this.#dependencies.history,
      runner: this.#dependencies.runner,
      scratchDirectory: this.#store.newImportDirectory(),
      importer,
    })
  }

  /**
   * Starts the Review Session, or resumes the open one under its pinned
   * project: re-checks the host, claims the device, launches the Build,
   * records the device in Recent, reads the project's schema, and saves a
   * new session.
   */
  start(
    request: {
      readonly deviceUDID: string
      readonly projectID: string | undefined
      /** The Build the page shows; undefined for one from before the Library. */
      readonly buildID: string | undefined
    },
    { user, youTrack }: YouTrackAccount
  ): Promise<StartOutcome> {
    return this.#perform(async () => {
      const open = await this.#store.openSession()
      const current =
        open === undefined
          ? this.#selection
          : this.#dependencies.library.entryID(open.build)
      // A page left behind by another tab's pick would start a Build it
      // doesn't show.
      if (request.buildID !== current) {
        throw new ReviewRefused(
          "Your Build changed since this page showed it, so the review didn't start. Reload the page to see which Build is yours now."
        )
      }
      // The open session keeps its Build in use; a new one holds its own.
      const lease: LibraryLease =
        open === undefined
          ? await this.#lease(current)
          : { build: open.build, release: () => {} }
      try {
        const build = lease.build
        // A missing Xcode or runtime shows as the host's reason before any boot.
        const health = await this.#dependencies.deviceHost.checkHealth()
        if (health.status === "notReady") {
          return { status: "hostNotReady", problem: health.problem }
        }
        const picked = deviceFor(build, request.deviceUDID, health.devices)
        const project =
          open?.project ?? (await this.#project(request.projectID, youTrack))
        const rollback = await this.#dependencies.deviceClaims.claim(
          user,
          picked
        )
        const device = await this.#dependencies.deviceHost
          .launchBuild(build, picked)
          .catch(async (error: unknown) => {
            await rollback()
            throw error
          })
        const recentDevices = await this.#recordRecentDevice(device)
        // Non-fatal: an empty schema hides the Editor's controls, and capture
        // and filing proceed regardless (ADR-0008).
        const schema = await loadProjectSchema(youTrack, project)
        const session = open ?? newReviewSession({ build, project })
        if (open === undefined) {
          await this.#serialized(() => this.#store.saveOpenSession(session))
          // A held result never shows beside a live session.
          this.#filing = { status: "idle" }
        }
        return {
          status: "started",
          session,
          device,
          schema,
          // The device as it now runs: booted, with an emulator's serial.
          devices: health.devices.map((listed) =>
            listed.udid === device.udid ? device : listed
          ),
          recentDevices,
          androidProblem: health.androidProblem,
          inspectProblem: health.inspectProblem,
        }
      } finally {
        lease.release()
      }
    })
  }

  /** The picked Build, held in use until the start saves its session. */
  async #lease(id: string | undefined): Promise<LibraryLease> {
    if (id === undefined) {
      throw new ReviewRefused(
        "Pick or upload a Build before starting a review."
      )
    }
    try {
      return await this.#dependencies.library.lease(id)
    } catch (error) {
      if (!(error instanceof LibraryBuildNotFound)) throw error
      this.#selection = undefined
      throw new ReviewRefused(
        "That Build was deleted from the Build Library. Pick another one."
      )
    }
  }

  /**
   * Relaunches the session's Build on another device. The session itself is
   * untouched, and a failure leaves Recent as it was.
   */
  switchDevice(
    deviceUDID: string,
    user: YouTrackUser
  ): Promise<{
    readonly device: SimulatorDevice
    readonly recentDevices: RecentDevices
  }> {
    return this.#perform(async () => {
      const open = await this.#store.openSession()
      if (open === undefined) {
        throw new ReviewRefused("There is no open review to switch devices in.")
      }
      const deviceHost = this.#dependencies.deviceHost
      const picked = deviceFor(
        open.build,
        deviceUDID,
        await deviceHost.devices.list()
      )
      const rollback = await this.#dependencies.deviceClaims.claim(user, picked)
      const device = await deviceHost
        .launchBuild(open.build, picked)
        .catch(async (error: unknown) => {
          await rollback()
          throw error
        })
      return { device, recentDevices: await this.#recordRecentDevice(device) }
    })
  }

  /**
   * Ends the Review Session without filing. Its Build stays picked, unless
   * it is from before the Library, and History is untouched.
   */
  end(): Promise<void> {
    return this.#perform(async () => {
      await this.#serialized(async () => {
        const open = await this.#store.openSession()
        if (open !== undefined) {
          this.#selection = this.#dependencies.library.entryID(open.build)
        }
        await this.#store.clearOpenSession()
        this.#dependencies.deviceClaims.release(this.#login)
        // Or the next session would open on a stale "File n remaining".
        this.#filing = { status: "idle" }
      })
      await this.#removeLegacyBuilds(undefined)
    })
  }

  /**
   * Files every Finding not yet filed, as AppModel's fileAllFindings. A run
   * already going refuses at once with ShellBusy; otherwise the run starts,
   * and the returned promise settles when it ends, without throwing: its
   * ending is `filingStatus`. The request that started it doesn't wait, so
   * closing the tab never stops a run.
   *
   * Each acknowledged step is saved before the next request (core's
   * fileAll), and the open session carries a mark while the run goes, so
   * a server killed mid-ladder resumes where it stopped on its next start.
   * The promise answers with the run's failure, undefined once filed.
   */
  fileAll(account: YouTrackAccount): Promise<unknown> {
    this.#activity = this.#activity.begin("filing")
    this.#filing = { status: "running" }
    return this.#file(account)
  }

  /**
   * Resumes the File all a server restart cut short, if one did, and
   * answers once the run is going, with the run: the server opens its port
   * only then, so a page loading meanwhile follows the run instead of
   * finding none. A mark without an open session is a run that recorded
   * History and died before removing it. A run already going owns the mark.
   */
  async resumeInterruptedFiling(
    account: YouTrackAccount
  ): Promise<{ readonly run: Promise<unknown> } | undefined> {
    if (this.#activity.isBusy || !(await this.#store.isMarkedFiling())) {
      return undefined
    }
    if ((await this.#store.openSession()) === undefined) {
      await this.#store.unmarkFiling()
      return undefined
    }
    return { run: this.fileAll(account) }
  }

  filingStatus(): FilingStatus {
    return this.#filing
  }

  /** Done on the filing result: home again, with the Build still loaded. */
  dismissFilingResult(): void {
    if (this.#filing.status === "filed") this.#filing = { status: "idle" }
  }

  async #file({ user, youTrack }: YouTrackAccount): Promise<unknown> {
    let outcome: FileAllOutcome | undefined
    let recorded: HistoryEntry | undefined
    let failure: unknown
    try {
      // In turn with the session's writes, so an edit already saving lands
      // before filing reads, and is never overwritten by an older copy.
      const session = await this.#serialized(() => this.#requireOpenSession())
      if (session.tray.length === 0) {
        throw new ReviewRefused("Capture a Finding before filing.")
      }
      await this.#store.markFiling()
      const record = async (entry: HistoryEntry) => {
        recorded = await this.#recordInHistory(session, {
          ...entry,
          filedBy: user,
        })
      }
      outcome = await fileAll(session, {
        youTrack,
        flatten: annotatedScreenshotPNG,
        store: {
          saveOpenSession: (next) =>
            this.#serialized(() => this.#store.saveOpenSession(next)),
          recordInHistory: record,
          capturePNG: (itemID) => readFile(this.#store.capturePath(itemID)),
          designSnapshotData: (itemID, snapshot) =>
            readFile(this.#store.designSnapshotPath(itemID, snapshot)),
        },
      })
      failure = outcome.failure
      // A restart that landed between the last filing mark and the History
      // record finds the whole Tray filed, and core files nothing: record
      // it now, as Swift's loadOpenSession healed it.
      if (
        failure === undefined &&
        recorded === undefined &&
        outcome.session.tray.every((item) => filedIssueOf(item) !== undefined)
      ) {
        await record(historyEntry(outcome.session))
      }
    } catch (error) {
      failure = error
    }
    const filed = failure === undefined && recorded !== undefined
    if (!filed) await this.#store.unmarkFiling().catch(() => {})
    // The ending and the end of the run publish together, so a retry the
    // page sends on seeing the ending is never refused as busy.
    const notice = outcome && droppedFieldNotice(outcome.droppedFields)
    const dropped = notice === undefined ? {} : { droppedFieldNotice: notice }
    this.#filing = filed
      ? { status: "filed", result: recorded!, ...dropped }
      : { status: "failed", error: failureMessage(failure), ...dropped }
    this.#activity = this.#activity.end()
    return filed ? undefined : failure
  }

  /**
   * Records the filed session in its filer's History, then clears the open
   * slot with its captures. The entry exists before the slot clears, so a
   * crash between the two resumes into a fully filed session, which records
   * again over the same file. The Build stays loaded for the next review.
   */
  async #recordInHistory(
    session: ReviewSession,
    entry: HistoryEntry
  ): Promise<HistoryEntry> {
    await this.#dependencies.history.record(entry)
    await this.#serialized(() => this.#store.clearOpenSession())
    this.#dependencies.deviceClaims.release(this.#login)
    this.#selection = this.#dependencies.library.entryID(session.build)
    await this.#removeLegacyBuilds(undefined)
    return entry
  }

  /**
   * Captures the device the Build runs on and drops the Finding into the
   * Tray, stamped with the Device Context in effect right now (ADR-0009).
   * A device that stopped refuses with DeviceNotRunning, and nothing
   * changes.
   */
  capture(deviceUDID: string): Promise<TrayItem> {
    return this.#perform(async () => {
      await this.#requireOpenSession()
      const capture =
        await this.#dependencies.deviceHost.captureScreen(deviceUDID)
      return this.#editSession(async (session) => {
        const added = addFinding(
          session,
          newFinding({
            summary: "",
            description: "",
            deviceContext: deviceContextOf(capture.device, capture.settings),
          })
        )
        await this.#store.writeCapture(added.id, capture.png)
        const item = added.session.tray.at(-1)!
        return { session: added.session, result: item }
      })
    })
  }

  /**
   * Inspect: the layout of what the Reviewer's device shows now (ADR-0015).
   * The device is the one they hold, which runs the open session's Build.
   * Not a run: hovering never holds up a capture.
   */
  async inspect(): Promise<Inspection> {
    await this.#requireOpenSession()
    const deviceUDID = this.#dependencies.deviceClaims.held(this.#login)
    if (deviceUDID === undefined) {
      throw new ReviewRefused(
        "Your review has no device running on the Device Host. Resume review to relaunch the Build."
      )
    }
    return this.#dependencies.deviceHost.inspectLayout(deviceUDID)
  }

  /** The session's own fields; today only its Design Reference. */
  editSession(patch: SessionPatch): Promise<void> {
    return this.#editSession((session) => ({
      session:
        patch.designReference === undefined
          ? session
          : {
              ...session,
              designReference: designReference(patch.designReference),
            },
      result: undefined,
    }))
  }

  /** Sets the fields `patch` names on an editable Finding. */
  editFinding(itemID: string, patch: FindingPatch): Promise<void> {
    return this.#editSession((session) => {
      editableItem(session, itemID)
      return {
        session: updateFinding(session, itemID, (finding) =>
          patchedFinding(finding, patch)
        ),
        result: undefined,
      }
    })
  }

  /**
   * Discards an editable Finding with its files. One already gone is no
   * error; one filing has touched is refused, since its Issue exists.
   */
  discard(itemID: string): Promise<void> {
    return this.#editSession((session) => {
      if (session.tray.some((item) => item.id === itemID)) {
        editableItem(session, itemID)
      }
      return { session: discardFinding(session, itemID), result: undefined }
    })
  }

  /** Adds an image file as a Design Snapshot, once its bytes check out. */
  async addDesignSnapshot(
    itemID: string,
    fileName: string,
    data: Uint8Array
  ): Promise<DesignSnapshot> {
    const mediaType = designSnapshotMediaType(fileName)
    await checkDesignSnapshotImage(data, mediaType)
    return this.#editSession(async (session) => {
      const added = addDesignSnapshot(session, itemID, {
        name: fileName,
        mediaType,
      })
      await this.#store.writeDesignSnapshot(itemID, added.snapshot, data)
      return { session: added.session, result: added.snapshot }
    })
  }

  /** New bytes for a Design Snapshot, which keeps its place and name. */
  async replaceDesignSnapshot(
    itemID: string,
    snapshotID: string,
    fileName: string,
    data: Uint8Array
  ): Promise<DesignSnapshot> {
    const mediaType = designSnapshotMediaType(fileName)
    await checkDesignSnapshotImage(data, mediaType)
    return this.#editSession(async (session) => {
      const replaced = replaceDesignSnapshot(
        session,
        itemID,
        snapshotID,
        mediaType
      )
      await this.#store.writeDesignSnapshot(itemID, replaced.snapshot, data)
      return { session: replaced.session, result: replaced.snapshot }
    })
  }

  renameDesignSnapshot(
    itemID: string,
    snapshotID: string,
    name: string
  ): Promise<DesignSnapshot> {
    return this.#editSession((session) => {
      const renamed = renameDesignSnapshot(session, itemID, snapshotID, name)
      const snapshot = renamed.tray
        .find((item) => item.id === itemID)!
        .finding.designSnapshots.find(
          (candidate) => candidate.id === snapshotID
        )!
      return { session: renamed, result: snapshot }
    })
  }

  removeDesignSnapshot(itemID: string, snapshotID: string): Promise<void> {
    return this.#editSession((session) => ({
      session: removeDesignSnapshot(session, itemID, snapshotID),
      result: undefined,
    }))
  }

  /** A capture's PNG, for a Finding in the open session. */
  async capturePNG(itemID: string): Promise<Buffer> {
    const session = await this.#requireOpenSession()
    const item = session.tray.find((candidate) => candidate.id === itemID)
    if (item === undefined) throw new FindingNotFound()
    return readOrNotFound(this.#store.capturePath(item.id))
  }

  /** The bytes a Design Snapshot's dataVersion names, with its media type. */
  async designSnapshotData(
    itemID: string,
    dataVersion: string
  ): Promise<{ readonly snapshot: DesignSnapshot; readonly data: Buffer }> {
    const session = await this.#requireOpenSession()
    const item = session.tray.find((candidate) => candidate.id === itemID)
    const snapshot = item?.finding.designSnapshots.find(
      (candidate) => candidate.dataVersion === dataVersion
    )
    if (item === undefined || snapshot === undefined) {
      throw new FindingNotFound()
    }
    return {
      snapshot,
      data: await readOrNotFound(
        this.#store.designSnapshotPath(item.id, snapshot)
      ),
    }
  }

  /**
   * Reads the open session, applies `change` and saves what it returns.
   * Edits don't wait on a run: a capture or a device switch leaves the Tray
   * to the Reviewer. Filing works on its own copy of the session, so edits
   * are refused while it runs.
   */
  #editSession<T>(
    change: (
      session: ReviewSession
    ) =>
      | { readonly session: ReviewSession; readonly result: T }
      | Promise<{ readonly session: ReviewSession; readonly result: T }>
  ): Promise<T> {
    return this.#serialized(async () => {
      if (this.#activity.isFiling) throw new ShellBusy()
      const session = await this.#requireOpenSession()
      const next = await change(session)
      if (next.session !== session) {
        await this.#store.saveOpenSession(next.session)
      }
      return next.result
    })
  }

  #serialized<T>(write: () => Promise<T>): Promise<T> {
    const result = this.#sessionWrites.then(write)
    this.#sessionWrites = result.catch(() => {})
    return result
  }

  async #requireOpenSession(): Promise<ReviewSession> {
    const session = await this.#store.openSession()
    if (session === undefined) {
      throw new ReviewRefused("There is no open review.")
    }
    return session
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
  async #project(
    projectID: string | undefined,
    youTrack: YouTrackClient
  ): Promise<YouTrackProject> {
    if (projectID === undefined) {
      throw new ReviewRefused(
        "Pick the YouTrack project the review files into."
      )
    }
    const { projects } = await verifyYouTrack(youTrack)
    const project = projects.find((candidate) => candidate.id === projectID)
    if (project === undefined) {
      throw new ReviewRefused(
        "That YouTrack project isn't visible to your YouTrack account."
      )
    }
    return project
  }
}

/** The run's error in the Reviewer's words: core's texts are already theirs. */
function failureMessage(failure: unknown): string {
  return failure instanceof Error && failure.message !== ""
    ? failure.message
    : "Filing stopped for an unknown reason."
}

/** The item, if filing hasn't touched it; its Issue would diverge otherwise. */
function editableItem(session: ReviewSession, itemID: string): TrayItem {
  const item = session.tray.find((candidate) => candidate.id === itemID)
  if (item === undefined) throw new FindingNotFound()
  if (!isEditable(item)) {
    throw new ReviewRefused(
      "This Finding has started filing, so it can no longer be edited."
    )
  }
  return item
}

async function readOrNotFound(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FindingNotFound()
    }
    throw error
  }
}

/** The device the Reviewer picked, when it is still there and runs the Build. */
function deviceFor(
  build: Build,
  udid: string,
  devices: ReadonlyArray<SimulatorDevice>
): SimulatorDevice {
  const device = devices.find((candidate) => candidate.udid === udid)
  if (device === undefined) {
    throw new ReviewRefused(
      "That device is no longer on the Device Host. Pick another one."
    )
  }
  if (buildPlatform(build) !== devicePlatform(device)) {
    throw new ReviewRefused(
      buildPlatform(build) === "android"
        ? "This Build is an Android app: pick an Android emulator."
        : "This Build is an iOS app: pick an iOS simulator."
    )
  }
  return device
}
