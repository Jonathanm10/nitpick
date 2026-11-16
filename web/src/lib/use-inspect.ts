// Inspect (ADR-0015): reading the live device's layout, then the element the
// Reviewer hovers and the one they select. It applies only while the live
// device stands on the stage: a Finding opening, the review pausing or the
// device changing ends it.
import { useRef, useState } from "react"
import { devicePlatform, type LayoutSnapshot } from "@nitpick/core"
import type { LayoutResponse, SimulatorDevice } from "@nitpick/server/api"
import { APIError } from "@/lib/api"

export type InspectReading =
  | { readonly status: "reading" }
  | {
      readonly status: "ready"
      readonly snapshot: LayoutSnapshot
      /** How long the read took, in milliseconds. */
      readonly duration: number
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | {
      readonly status: "failed"
      readonly message: string
      /** The Build didn't answer, as when it is still starting: try again. */
      readonly canRetry: boolean
    }

interface Inspecting {
  readonly deviceUDID: string
  /** Counts reads, so an answer that comes after a newer read is dropped. */
  readonly request: number
  readonly reading: InspectReading
  readonly selected?: string
  readonly hovered?: string
}

/** Why an Android review can't inspect; the server says the same. */
const androidReason =
  "Inspect reads SwiftUI layouts on iOS simulators, so it isn't available on Android emulators."

export function useInspect({
  device,
  isLive,
  hostProblem,
  readLayout,
}: {
  /** The device the Build runs on; none while the review is paused. */
  readonly device: SimulatorDevice | undefined
  /** Why the host launches iOS Builds without Inspect, when it does. */
  readonly hostProblem: string | undefined
  /** Whether the live device stands on the stage, rather than in its corner. */
  readonly isLive: boolean
  readonly readLayout: () => Promise<LayoutResponse>
}) {
  const [state, setState] = useState<Inspecting>()
  const requests = useRef(0)

  // Leaving the stage, pausing or switching devices ends Inspect: what it
  // read belongs to that device at that moment.
  if (state !== undefined && (!isLive || state.deviceUDID !== device?.udid)) {
    setState(undefined)
  }

  const unavailableReason =
    device === undefined
      ? undefined
      : devicePlatform(device) === "android"
        ? androidReason
        : hostProblem
  const canInspect =
    device !== undefined && isLive && unavailableReason === undefined

  /** Reads the layout afresh; a selection still on screen stays selected. */
  function read(deviceUDID: string, selected?: string) {
    const request = ++requests.current
    const started = performance.now()
    setState({ deviceUDID, request, reading: { status: "reading" }, selected })
    const settle = (reading: InspectReading) =>
      setState((current) => {
        if (current?.request !== request) return current
        const kept =
          reading.status === "ready" &&
          reading.snapshot.elements.some((element) => element.id === selected)
        return {
          deviceUDID,
          request,
          reading,
          ...(kept && { selected }),
        }
      })
    readLayout().then(
      (response) =>
        settle(
          response.status === "ready"
            ? {
                status: "ready",
                snapshot: response.snapshot,
                duration: performance.now() - started,
              }
            : response
        ),
      (error: unknown) =>
        settle({
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
          canRetry:
            error instanceof APIError &&
            (error.status === undefined || error.status === 502),
        })
    )
  }

  function enter() {
    if (canInspect && state === undefined) read(device.udid)
  }

  function leave() {
    setState(undefined)
  }

  function refresh() {
    if (state !== undefined) read(state.deviceUDID, state.selected)
  }

  /** The element under the pointer, or none. */
  function hover(id: string | undefined) {
    setState((current) =>
      current === undefined || current.hovered === id
        ? current
        : { ...current, hovered: id }
    )
  }

  /** A click: selects the element, or deselects it or on empty space. */
  function select(id: string | undefined) {
    setState((current) =>
      current === undefined
        ? current
        : { ...current, selected: current.selected === id ? undefined : id }
    )
  }

  const snapshot =
    state?.reading.status === "ready" ? state.reading.snapshot : undefined
  const find = (id: string | undefined) =>
    id === undefined
      ? undefined
      : snapshot?.elements.find((element) => element.id === id)

  return {
    isOn: state !== undefined,
    reading: state?.reading,
    snapshot,
    selected: find(state?.selected),
    hovered: find(state?.hovered),
    canInspect,
    /** Why the control is off for this device, when it is. */
    unavailableReason,
    enter,
    leave,
    toggle: () => (state === undefined ? enter() : leave()),
    refresh,
    hover,
    select,
  }
}

export type Inspect = ReturnType<typeof useInspect>
