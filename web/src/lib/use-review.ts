// The page's state and actions, after Sources/Nitpick/AppModel.swift's
// ingest, startReview, switchDevice and endReview. The server keeps the
// Build, the open session and Recent; the page keeps which device the Build
// runs on, so a reload shows the session paused until Resume review.
import { useCallback, useEffect, useRef, useState } from "react"
import {
  RecentDevices,
  reviewStart,
  ShellBusy,
  type ProjectSchema,
  type YouTrackProject,
} from "@nitpick/core"
import type {
  HostResponse,
  ReviewStateResponse,
  SimulatorDevice,
} from "@nitpick/server/api"
import { api } from "@/lib/api"

export type Loadable<T> =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: string }
  | ({ readonly status: "loaded" } & T)

/** The Build running on a device: exists only after a successful launch. */
export interface ReviewRun {
  readonly device: SimulatorDevice
  /** Read at Start review for the Editor's Priority and Assignee (issue 07). */
  readonly schema: ProjectSchema
}

/** How often a running review checks that its device is still up. */
const devicePollInterval = 10_000

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
  const [isBusy, setIsBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string>()
  // Reads the latest busy state inside callbacks created before it changed.
  const busy = useRef(false)

  const state = review.status === "loaded" ? review : undefined
  const session = state?.session
  const devices = host.status === "ready" ? host.devices : []
  const selectedDevice = devices.find(
    (device) => device.udid === selectedDeviceUDID
  )
  const projectList = projects.status === "loaded" ? projects.projects : []
  const selectedProject = projectList.find(
    (project) => project.id === selectedProjectID
  )

  /** One action at a time, as ShellActivity has it; a refusal says why. */
  const perform = useCallback(async (action: () => Promise<void>) => {
    if (busy.current) {
      setErrorMessage(new ShellBusy().message)
      return
    }
    busy.current = true
    setIsBusy(true)
    setErrorMessage(undefined)
    try {
      await action()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      busy.current = false
      setIsBusy(false)
    }
  }, [])

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
  }, [applyHost])

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
  }, [run, applyHost])

  const start = reviewStart({
    build: state?.build,
    isReviewing: run !== undefined,
    // The filing result arrives with File all (issue 08).
    holdsFilingResult: false,
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
      setRun({ device: outcome.device, schema: outcome.schema })
      setReview((current) =>
        current.status === "loaded"
          ? { ...current, session: outcome.session }
          : current
      )
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
      setReview({ status: "loaded", build })
      await refreshHost()
    })
  }

  async function endReview() {
    await perform(async () => {
      await api.endReview()
      setRun(undefined)
      setReview((current) =>
        current.status === "loaded"
          ? { status: "loaded", build: current.build }
          : current
      )
    })
  }

  async function checkHostAgain() {
    await perform(refreshHost)
  }

  /** A drop that bounces while work runs says why. */
  function reportBusyDrop() {
    setErrorMessage(new ShellBusy().message)
  }

  return {
    review,
    host,
    projects,
    devices,
    recentDeviceUDIDs: host.status === "ready" ? host.recentDeviceUDIDs : [],
    selectedDevice,
    selectedProjectID,
    setSelectedProjectID,
    run,
    isBusy,
    busy,
    errorMessage,
    startTitle: session === undefined ? "Start review" : "Resume review",
    missingForStart: missingForStart(),
    startReview,
    selectDevice,
    ingest,
    endReview,
    checkHostAgain,
    reportBusyDrop,
  }
}
