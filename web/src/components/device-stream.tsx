import { useCallback, useEffect, useRef, useState } from "react"
import { hidUsage } from "@nitpick/core"
import type { SimulatorDevice } from "@nitpick/server/api"
import { CircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { api } from "@/lib/api"
import {
  createDeviceStreamClient,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "@/lib/device-stream"

/** Marks the stream's element, which Return to the Build focuses. */
const streamAttribute = "data-device-stream"

/**
 * Return to the Build: focus moves to the device in the page, so typing goes
 * to the device. False when no device is showing.
 */
export function focusDeviceStream(): boolean {
  const stream = document.querySelector<HTMLElement>(`[${streamAttribute}]`)
  stream?.focus()
  return stream !== null
}

type Attachment =
  | { readonly kind: "attaching" }
  | { readonly kind: "attached" }
  | { readonly kind: "failed"; readonly message: string }

/**
 * The device the Build runs on, live from the Device Host. The server first
 * starts streaming it; then the stream shows here, reached with the sign-in
 * cookie, and taps, scrolling and typing go back to it.
 */
export function DeviceStream({ device }: { readonly device: SimulatorDevice }) {
  const [attachment, setAttachment] = useState<Attachment>({
    kind: "attaching",
  })
  const [attempt, setAttempt] = useState(0)
  const retry = () => {
    setAttachment({ kind: "attaching" })
    setAttempt((count) => count + 1)
  }

  useEffect(() => {
    let cancelled = false
    api
      .startDeviceStream(device.udid)
      .then(() => !cancelled && setAttachment({ kind: "attached" }))
      .catch((error: unknown) => {
        if (cancelled) return
        setAttachment({
          kind: "failed",
          message:
            error instanceof Error
              ? error.message
              : "The device stream couldn't start.",
        })
      })
    return () => {
      cancelled = true
    }
  }, [device.udid, attempt])

  switch (attachment.kind) {
    case "attaching":
      return (
        <DeviceFrame>
          <Spinner />
          Starting the device stream…
        </DeviceFrame>
      )
    case "failed":
      return (
        <DeviceFrame>
          <p role="alert" className="text-destructive select-text">
            {attachment.message}
          </p>
          <Button size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </DeviceFrame>
      )
    case "attached":
      return (
        <LiveDevice
          key={`${device.udid}:${attempt}`}
          device={device}
          // The stream's 401 says no more; asking who is signed in shows
          // sign-in with the reason, or tries again if the sign-in holds.
          onUnauthorized={() => {
            api.me().then(retry, () =>
              setAttachment({
                kind: "failed",
                message: "The device stream needs you signed in.",
              })
            )
          }}
          onReconnect={retry}
        />
      )
  }
}

/** The empty device-shaped slot, with a message in it. */
function DeviceFrame({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex aspect-[9/19.5] max-h-full min-h-0 flex-col items-center justify-center gap-3 rounded-[2rem] border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** Left and right Shift, by HID usage. */
const shiftKeys = [hidUsage("ShiftLeft")!, hidUsage("ShiftRight")!]

/** How long a wheel gesture may pause before its drag lets go. */
const wheelRelease = 120

/**
 * The stream itself. A pointer drag is a touch; the wheel or a trackpad
 * scrolls by dragging the screen as a finger would. While it has focus,
 * keys go to the device, except chords with ⌘ or Ctrl, which stay the
 * page's, and Esc, which hands focus back to the page.
 */
function LiveDevice({
  device,
  onUnauthorized,
  onReconnect,
}: {
  readonly device: SimulatorDevice
  readonly onUnauthorized: () => void
  readonly onReconnect: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [client, setClient] = useState<DeviceStreamClient>()
  const [status, setStatus] = useState<
    Exclude<DeviceStreamStatus, { kind: "unauthorized" }>
  >({ kind: "connecting" })
  const [screen, setScreen] = useState({ width: 1206, height: 2622 })
  const [mjpegURL, setMjpegURL] = useState<string>()
  const latest = useRef({ onUnauthorized })
  useEffect(() => {
    latest.current = { onUnauthorized }
  })

  useEffect(() => {
    const started = createDeviceStreamClient(device.udid, canvas.current!, {
      onStatus: (next) => {
        if (next.kind === "unauthorized") latest.current.onUnauthorized()
        else setStatus(next)
      },
      onScreen: (width, height) => setScreen({ width, height }),
      onMjpeg: setMjpegURL,
    })
    setClient(started)
    started.start()
    return () => started.stop()
  }, [device.udid])

  const watchImage = useCallback(
    (image: HTMLImageElement | null) => client?.watchMjpegImage(image),
    [client]
  )

  // React's wheel listener is passive, so the page would scroll too.
  useEffect(() => {
    const element = surface.current
    if (element === null || client === undefined) return
    let gesture: { x: number; y: number } | undefined
    let release: ReturnType<typeof setTimeout> | undefined
    function wheel(event: WheelEvent) {
      event.preventDefault()
      const bounds = shownScreen(element!.getBoundingClientRect(), screen)
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      if (gesture === undefined) {
        gesture = pointIn(bounds, event)
        client!.touch("begin", gesture.x, gesture.y)
      }
      gesture = {
        x: clamp(gesture.x - (event.deltaX * scale) / bounds.width),
        y: clamp(gesture.y - (event.deltaY * scale) / bounds.height),
      }
      client!.touch("move", gesture.x, gesture.y)
      clearTimeout(release)
      release = setTimeout(() => {
        if (gesture !== undefined) client!.touch("end", gesture.x, gesture.y)
        gesture = undefined
      }, wheelRelease)
    }
    element.addEventListener("wheel", wheel, { passive: false })
    return () => {
      element.removeEventListener("wheel", wheel)
      clearTimeout(release)
    }
  }, [client, screen])

  const pointerDown = useRef(false)
  const touch =
    (phase: "begin" | "move" | "end") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (phase === "begin") {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        // Scrolling the page now would move the screen under the finger.
        event.currentTarget.focus({ preventScroll: true })
        pointerDown.current = true
      } else if (!pointerDown.current) {
        return
      }
      if (phase === "end") pointerDown.current = false
      const bounds = event.currentTarget.getBoundingClientRect()
      const { x, y } = pointIn(shownScreen(bounds, screen), event)
      client?.touch(phase, x, y)
    }

  // The keys down on the device, so leaving the stream leaves none held.
  const held = useRef(new Set<number>())
  const press = (phase: "down" | "up", usage: number) => {
    if (phase === "down") held.current.add(usage)
    else held.current.delete(usage)
    client?.key(phase, usage)
  }
  const releaseAll = () => {
    for (const usage of [...held.current]) press("up", usage)
  }

  function key(
    phase: "down" | "up",
    event: React.KeyboardEvent<HTMLDivElement>
  ) {
    const usage = hidUsage(event.code)
    if (phase === "up") {
      // A key the device has down goes up there, whatever is held now.
      if (usage !== undefined && held.current.has(usage)) {
        event.preventDefault()
        press("up", usage)
      }
      return
    }
    if (event.metaKey || event.ctrlKey) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (usage === undefined) return
    event.preventDefault()
    if (event.repeat) return
    // A character that needs Shift can come without Shift's own key
    // event, from a key remapper or an automated keyboard, so the device's
    // Shift follows the event's.
    if (!shiftKeys.includes(usage)) {
      const shiftHeld = shiftKeys.some((shift) => held.current.has(shift))
      if (event.shiftKey && !shiftHeld) press("down", shiftKeys[0]!)
      if (!event.shiftKey && shiftHeld) {
        for (const shift of shiftKeys) {
          if (held.current.has(shift)) press("up", shift)
        }
      }
    }
    press("down", usage)
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div
        ref={surface}
        {...{ [streamAttribute]: "" }}
        data-status={status.kind}
        data-transport={mjpegURL === undefined ? "h264" : "mjpeg"}
        tabIndex={0}
        role="application"
        aria-label={`${device.name} on the Device Host. Esc leaves the device.`}
        className="relative min-h-0 w-full shrink touch-none overflow-hidden rounded-[1.75rem] border bg-black outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
        onPointerDown={touch("begin")}
        onPointerMove={touch("move")}
        onPointerUp={touch("end")}
        onPointerCancel={touch("end")}
        onKeyDown={(event) => key("down", event)}
        onKeyUp={(event) => key("up", event)}
        onBlur={releaseAll}
      >
        <canvas
          ref={canvas}
          className={`size-full object-contain ${mjpegURL === undefined ? "" : "hidden"}`}
        />
        {mjpegURL !== undefined && (
          <img
            ref={watchImage}
            alt=""
            draggable={false}
            className="size-full object-contain"
          />
        )}
        {status.kind !== "streaming" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-4 text-center text-sm text-white">
            {status.kind === "connecting" ? (
              <>
                <Spinner />
                Connecting to {device.name}…
              </>
            ) : (
              <>
                <p role="alert" className="select-text">
                  {status.message}
                </p>
                <Button size="sm" variant="secondary" onClick={onReconnect}>
                  Reconnect
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant="ghost"
        className="self-center text-muted-foreground"
        disabled={status.kind !== "streaming"}
        onClick={() => client?.pressHome()}
      >
        <CircleIcon />
        Home
      </Button>
    </div>
  )
}

/**
 * Where the screen shows inside the element: the whole of it, or centred
 * between bars when the column is too short for the device.
 */
function shownScreen(
  bounds: DOMRect,
  screen: { readonly width: number; readonly height: number }
) {
  const scale = Math.min(
    bounds.width / screen.width,
    bounds.height / screen.height
  )
  const width = screen.width * scale
  const height = screen.height * scale
  return {
    left: bounds.left + (bounds.width - width) / 2,
    top: bounds.top + (bounds.height - height) / 2,
    width,
    height,
  }
}

function pointIn(
  bounds: {
    readonly left: number
    readonly top: number
    readonly width: number
    readonly height: number
  },
  event: { readonly clientX: number; readonly clientY: number }
) {
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height),
  }
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}
