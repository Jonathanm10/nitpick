// The page's state and actions, after Sources/Nitpick/AppModel.swift's
// ingest, startReview, switchDevice, endReview, captureScreen, the Editor's
// edits and fileAllFindings. The server keeps the Build, the open session,
// Recent and the File all run; the page keeps which device the Build runs
// on, so a reload shows the session paused until Resume review. The page
// edits its copy of the session at once and the saver sends the edits.
import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import {
  discardFinding,
  filingPhase,
  findingsNeedingSummary,
  historyFiledBy,
  historyTrace,
  RecentDevices,
  reviewStart,
  ShellBusy,
  unfiledFindingCount,
  updateFinding,
  type DesignSnapshot,
  type Finding,
  type ProjectSchema,
  type TrayItem,
  type YouTrackProject,
} from "@nitpick/core"
import type {
  FilingStatus,
  FindingPatch,
  HistoryResponse,
  HostResponse,
  ReviewStateResponse,
  SessionSummary,
  SimulatorDevice,
} from "@nitpick/server/api"
import { api, APIError } from "@/lib/api"
import { SessionSaver, type FindingField } from "@/lib/session-saver"

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: string }
  | ({ readonly status: "loaded" } & T)

/** The Build running on a device: exists only after a successful launch. */
export interface ReviewRun {
  readonly device: SimulatorDevice
}

const emptySchema: ProjectSchema = { priorities: [], assignees: [] }

/** How often a running review checks that its device is still up. */
const devicePollInterval = 10_000

/** How often the page reads a File all run's progress from the server. */
const filingPollInterval = 400

const idle: FilingStatus = { status: "idle" }

export function useReview() {
  const [review, setReview] = useState<Loadable<ReviewStateResponse>>({
    status: "loading",
  })
  const [host, setHost] = useState<HostResponse | { status: "loading" }>({
    status: "loading",
  })
  const [projects, setProjects] = useState<
    Loadable<{ readonly projects: ReadonlyArray<YouTrackProject> }>
  >({ status: "loading" })
  const [selectedDeviceUDID, setSelectedDeviceUDID] = useState<string>()
  const [selectedProjectID, setSelectedProjectID] = useState<string>()
  const [run, setRun] = useState<ReviewRun>()
  /**
   * The project's Priority scale and Assignees, read at Start review and
   * kept while the session is open, as AppModel's sessionSchema.
   */
  const [schema, setSchema] = useState(emptySchema)
  const [history, setHistory] = useState<Loadable<HistoryResponse>>({
    status: "loading",
  })
  const [isPerforming, setIsPerforming] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  // Read inside callbacks created before they changed: an action of the
  // page's own, and a File all run on the server.
  const performing = useRef(false)
  const filingRuns = useRef(false)
  const [busy] = useState(() => ({
    get current() {
      return performing.current || filingRuns.current
    },
  }))
  const [saver] = useState(() => new SessionSaver(setSaveError))
  // Signed out or rejected, the page unmounts: a save still pending, or a
  // retry, would otherwise go out under the next Reviewer's sign-in.
  useEffect(() => {
    saver.start()
    return () => saver.stop()
  }, [saver])

  const state = review.status === "loaded" ? review : undefined
  const session = state?.session
  const filing = state?.filing ?? idle
  const isFiling = filing.status === "running"
  filingRuns.current = isFiling
  /** Busy while the page acts or File all runs, as ShellActivity has it. */
  const isBusy = isPerforming || isFiling

  /** The page's copy of the open session, for the saver too. */
  const setSession = useCallback(
    (next: SessionSummary | undefined) => {
      if (next === undefined) {
        saver.cancel()
        setSchema(emptySchema)
      }
      saver.track(next)
      setReview((current) =>
        current.status === "loaded" ? { ...current, session: next } : current
      )
    },
    [saver]
  )
  const devices = host.status === "ready" ? host.devices : []
  const selectedDevice = devices.find(
    (device) => device.udid === selectedDeviceUDID
  )
  const projectList = projects.status === "loaded" ? projects.projects : []
  const selectedProject = projectList.find(
    (project) => project.id === selectedProjectID
  )

  /** One action at a time, as ShellActivity has it; a refusal says why. */
  const perform = useCallback(
    async (action: () => Promise<void>) => {
      if (busy.current) {
        setErrorMessage(new ShellBusy().message)
        return
      }
      performing.current = true
      setIsPerforming(true)
      setErrorMessage(undefined)
      try {
        await action()
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : String(error))
      } finally {
        performing.current = false
        setIsPerforming(false)
      }
    },
    [busy]
  )

  /** The shared History, re-read after each filing and on its page. */
  const refreshHistory = useCallback(
    () =>
      api
        .history()
        .then((loaded) => setHistory({ status: "loaded", ...loaded }))
        .catch((error: Error) =>
          setHistory({ status: "failed", error: error.message })
        ),
    []
  )

  /**
   * Publishes the host check. A selection whose device vanished or lost its
   * runtime would leave Start review dead, so it falls back to the most
   * recent available device, else the first usable one.
   */
  const applyHost = useCallback((next: HostResponse) => {
    setHost(next)
    if (next.status !== "ready") return
    setSelectedDeviceUDID((current) => {
      const kept = next.devices.find((device) => device.udid === current)
      if (kept?.isRuntimeAvailable) return current
      return new RecentDevices(next.recentDeviceUDIDs).preferredDevice(
        next.devices
      )?.udid
    })
  }, [])

  const refreshHost = useCallback(
    async () => applyHost(await api.host()),
    [applyHost]
  )

  // The page load: the Build and open session, the host check, the projects.
  useEffect(() => {
    api
      .review()
      .then((loaded) => {
        saver.track(loaded.session)
        setReview({ status: "loaded", ...loaded })
        if (loaded.session) setSelectedProjectID(loaded.session.project.id)
      })
      .catch((error: Error) =>
        setReview({ status: "failed", error: error.message })
      )
    api
      .host()
      .then(applyHost)
      .catch((error: Error) => setErrorMessage(error.message))
    api
      .projects()
      .then(({ projects }) => {
        setProjects({ status: "loaded", projects })
        setSelectedProjectID((current) => current ?? projects[0]?.id)
      })
      .catch((error: Error) =>
        setProjects({ status: "failed", error: error.message })
      )
    void refreshHistory()
  }, [applyHost, saver, refreshHistory])

  // File all runs on the server, so the page reads its progress, a reload
  // included: each mark lands in the Tray, and the run's end shows the
  // filing result, or the error with the rows that didn't file.
  useEffect(() => {
    if (!isFiling) return
    let cancelled = false
    const timer = setInterval(() => {
      api
        .review()
        .then((loaded) => {
          if (cancelled) return
          const ended = loaded.filing.status !== "running"
          if (ended) cancelled = true
          if (loaded.filing.status === "filed") {
            // The Review Session is over: the device run goes with it.
            setRun(undefined)
            saver.cancel()
            setSchema(emptySchema)
          }
          saver.track(loaded.session)
          setReview({ status: "loaded", ...loaded })
          if (!ended) return
          if (loaded.filing.status === "failed") {
            setErrorMessage(loaded.filing.error)
          }
          if (
            loaded.filing.status !== "idle" &&
            "droppedFieldNotice" in loaded.filing &&
            loaded.filing.droppedFieldNotice !== undefined
          ) {
            toast.warning(loaded.filing.droppedFieldNotice, { duration: 8000 })
          }
          void refreshHistory()
        })
        .catch(() => {})
    }, filingPollInterval)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isFiling, saver, refreshHistory])

  // A device that stops on the host (a crash, a host reboot) pauses the
  // review: the session stays, and Resume review relaunches the Build.
  useEffect(() => {
    if (run === undefined) return
    const check = () => {
      if (busy.current || document.visibilityState !== "visible") return
      api
        .host()
        .then((next) => {
          if (busy.current) return
          const running =
            next.status === "ready" &&
            next.devices.some(
              (device) => device.udid === run.device.udid && device.isBooted
            )
          if (running) return
          setRun(undefined)
          setErrorMessage(
            `${run.device.name} is no longer running on the Device Host, so the review is paused.`
          )
          applyHost(next)
        })
        .catch(() => {})
    }
    const timer = setInterval(check, devicePollInterval)
    document.addEventListener("visibilitychange", check)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", check)
    }
  }, [run, applyHost, busy])

  const start = reviewStart({
    build: state?.build,
    isReviewing: run !== undefined,
    holdsFilingResult: filing.status === "filed",
    device: selectedDevice,
    session,
    selectedProject,
    isBusy,
  })

  /** Why Start review is disabled, for its tooltip. */
  function missingForStart(): string | undefined {
    if (start !== undefined || isBusy) return undefined
    if (state?.build === undefined) return "Upload a Build to review."
    if (selectedDevice === undefined) return "Pick a device to review on."
    if (!selectedDevice.isRuntimeAvailable) {
      return "This device's runtime is missing on the Device Host. Pick another one."
    }
    if (session === undefined && selectedProject === undefined) {
      return "Pick the YouTrack project the review files into."
    }
    return undefined
  }

  async function startReview() {
    if (start === undefined || selectedDevice === undefined) return
    await perform(async () => {
      const outcome = await api.startReview({
        deviceUDID: selectedDevice.udid,
        projectID: start.project.id,
      })
      if (outcome.status === "notReady") {
        setHost(outcome)
        return
      }
      applyHost(outcome.host)
      setSelectedDeviceUDID(outcome.device.udid)
      setRun({ device: outcome.device })
      setSchema(outcome.schema)
      // A resumed session keeps the page's copy, edits not yet saved included.
      if (saver.session === undefined) setSession(outcome.session)
    })
  }

  /**
   * Choosing a device while the Build runs relaunches it there, and a
   * failure reverts the selection; otherwise it is a plain preselection.
   */
  async function selectDevice(device: SimulatorDevice) {
    if (run === undefined) {
      setSelectedDeviceUDID(device.udid)
      return
    }
    if (device.udid === run.device.udid || !device.isRuntimeAvailable) return
    await perform(async () => {
      setSelectedDeviceUDID(device.udid)
      try {
        const switched = await api.switchDevice(device.udid)
        setRun({ ...run, device: switched.device })
        setHost((current) =>
          current.status === "ready"
            ? { ...current, recentDeviceUDIDs: switched.recentDeviceUDIDs }
            : current
        )
      } catch (error) {
        setSelectedDeviceUDID(run.device.udid)
        throw error
      }
    })
  }

  /** A bad upload changes nothing; a good one ends the open session. */
  async function ingest(file: File) {
    await perform(async () => {
      const { build } = await api.uploadBuild(file)
      setRun(undefined)
      setSession(undefined)
      // The next Build dismisses a held filing result too (ADR-0007).
      setReview({ status: "loaded", build, filing: idle })
      await refreshHost()
    })
  }

  async function endReview() {
    await perform(async () => {
      await api.endReview()
      setRun(undefined)
      setSession(undefined)
      setFiling(idle)
    })
  }

  function setFiling(next: FilingStatus) {
    setReview((current) =>
      current.status === "loaded" ? { ...current, filing: next } : current
    )
  }

  const unfiled = session === undefined ? 0 : unfiledFindingCount(session)
  const needingSummary =
    session === undefined ? [] : findingsNeedingSummary(session)

  /**
   * Files every unfiled Finding, once each has a summary. Typed text is
   * saved first: the server files what it has stored, and a failed save
   * stops File all before any Issue exists. The run then goes on on the
   * server, and the page follows it.
   */
  async function fileAll() {
    if (session === undefined || unfiled === 0 || needingSummary.length > 0) {
      return
    }
    await perform(async () => {
      if (!(await saver.saveAll())) {
        throw new Error(
          "Your edits aren't saved yet, so File all didn't start. Try again once they are."
        )
      }
      setFiling((await api.fileAll()).filing)
    })
  }

  /** Done on the filing result: home, with the Build still loaded. */
  async function dismissFilingResult() {
    await perform(async () => {
      await api.dismissFilingResult()
      setFiling(idle)
    })
  }

  /**
   * Captures the device the Build runs on. The new Finding lands last in
   * the Tray; its id comes back for the Editor to open. A device that
   * stopped pauses the review, as AppModel's captureScreen does.
   */
  async function capture(): Promise<string | undefined> {
    if (run === undefined) return undefined
    let captured: TrayItem | undefined
    await perform(async () => {
      try {
        ;({ item: captured } = await api.capture(run.device.udid))
      } catch (error) {
        if (error instanceof APIError && error.code === "deviceNotRunning") {
          setRun(undefined)
        }
        throw error
      }
      const current = saver.session
      if (current !== undefined && captured !== undefined) {
        setSession({ ...current, tray: [...current.tray, captured] })
      }
    })
    return captured?.id
  }

  /**
   * Sets Finding fields in the page at once and saves them: typing once it
   * pauses, anything else now. Frozen Findings refuse, as in the core.
   */
  function editFinding(
    itemID: string,
    patch: FindingPatch,
    { typing = false }: { readonly typing?: boolean } = {}
  ) {
    const current = saver.session
    if (current === undefined || busy.current) return
    const next = updateFinding(current, itemID, (finding) =>
      patchedFinding(finding, patch)
    )
    if (next === current) return
    setSession(next)
    saver.findingEdited(itemID, Object.keys(patch) as FindingField[], {
      typing,
    })
  }

  function editSessionDesignReference(designReference: string | undefined) {
    const current = saver.session
    if (current === undefined || busy.current) return
    setSession({ ...current, designReference })
    saver.sessionEdited()
  }

  /**
   * Discards a Finding at once, with no undo. Should the server refuse, the
   * Finding comes back where it was, the error says why, and its edits not
   * yet saved go out.
   */
  async function discard(itemID: string) {
    const current = saver.session
    if (current === undefined) return
    const index = current.tray.findIndex((item) => item.id === itemID)
    if (index === -1) return
    setSession(discardFinding(current, itemID))
    try {
      await api.discardFinding(itemID)
      saver.forget(itemID)
    } catch (error) {
      const now = saver.session
      if (now !== undefined) {
        setSession({
          ...now,
          tray: now.tray.toSpliced(index, 0, current.tray[index]),
        })
      }
      setErrorMessage(error instanceof Error ? error.message : String(error))
      void saver.flush()
    }
  }

  /** Applies a Design Snapshot change the server made to the page's copy. */
  function setDesignSnapshots(
    itemID: string,
    change: (snapshots: ReadonlyArray<DesignSnapshot>) => DesignSnapshot[]
  ) {
    const current = saver.session
    if (current === undefined) return
    setSession(
      updateFinding(current, itemID, (finding) => ({
        ...finding,
        designSnapshots: change(finding.designSnapshots),
      }))
    )
  }

  async function checkHostAgain() {
    await perform(refreshHost)
  }

  /** A drop that bounces while work runs says why. */
  function reportBusyDrop() {
    setErrorMessage(new ShellBusy().message)
  }

  // Typed text still waiting for its pause goes out when the tab hides.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") void saver.flush()
    }
    document.addEventListener("visibilitychange", flush)
    return () => document.removeEventListener("visibilitychange", flush)
  }, [saver])

  const reviewer = history.status === "loaded" ? history.reviewer : undefined
  const historyEntries = history.status === "loaded" ? history.entries : []

  return {
    review,
    host,
    projects,
    history,
    refreshHistory,
    /** The signed-in Reviewer's last session, for the home trace line. */
    trace:
      reviewer === undefined
        ? undefined
        : historyTrace(historyFiledBy(historyEntries, reviewer)),
    filing,
    filingPhase:
      session &&
      filingPhase(session, {
        isRunning: isFiling,
        stoppedByFailure: filing.status === "failed",
      }),
    needingSummary,
    fileAll,
    dismissFilingResult,
    devices,
    recentDeviceUDIDs: host.status === "ready" ? host.recentDeviceUDIDs : [],
    selectedDevice,
    selectedProjectID,
    setSelectedProjectID,
    run,
    schema,
    isBusy,
    busy,
    errorMessage,
    saveError,
    setErrorMessage,
    startTitle: session === undefined ? "Start review" : "Resume review",
    missingForStart: missingForStart(),
    startReview,
    selectDevice,
    ingest,
    endReview,
    checkHostAgain,
    reportBusyDrop,
    capture,
    editFinding,
    editSessionDesignReference,
    discard,
    setDesignSnapshots,
    /** Sends every pending edit; false when one couldn't be saved. */
    saveEdits: () => saver.saveAll(),
  }
}

/** The Finding with the patch's fields; null clears an optional one. */
function patchedFinding(finding: Finding, patch: FindingPatch): Finding {
  const next: Record<string, unknown> = { ...finding }
  for (const [field, value] of Object.entries(patch)) {
    next[field] = value ?? undefined
  }
  return next as unknown as Finding
}
