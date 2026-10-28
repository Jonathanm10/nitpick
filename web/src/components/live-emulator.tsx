import { useEffect, useRef, useState } from "react"
import type { SimulatorDevice } from "@nitpick/server/api"
import { ArrowLeftIcon, CircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StreamOverlay, type ShownStatus } from "@/components/stream-overlay"
import {
  androidKeycodes,
  createEmulatorStreamClient,
  type EmulatorStreamClient,
} from "@/lib/emulator-stream"
import {
  clamp,
  pointIn,
  shownScreen,
  streamAttribute,
  wheelRelease,
} from "@/lib/stream-surface"

/**
 * An Android emulator's stream, as LiveDevice is a simulator's: a pointer
 * drag is a finger, the wheel or a trackpad scrolls by dragging, and while
 * it has focus typing goes to the emulator, except chords with ⌘ or Ctrl,
 * which stay the page's, and Esc, which hands focus back. Android's own
 * Back and Home sit under it.
 */
export function LiveEmulator({
  device,
  serial,
  onUnauthorized,
  onReconnect,
}: {
  readonly device: SimulatorDevice
  /** serve-emu's name for the running emulator. */
  readonly serial: string
  readonly onUnauthorized: () => void
  readonly onReconnect: () => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const [client, setClient] = useState<EmulatorStreamClient>()
  const [status, setStatus] = useState<ShownStatus>({ kind: "connecting" })
  const [screen, setScreen] = useState({ width: 1080, height: 2424 })
  const latest = useRef({ onUnauthorized })
  useEffect(() => {
    latest.current = { onUnauthorized }
  })

  useEffect(() => {
    const started = createEmulatorStreamClient(serial, video.current!, {
      onStatus: (next) => {
        if (next.kind === "unauthorized") latest.current.onUnauthorized()
        else setStatus(next)
      },
      onScreen: (width, height) => setScreen({ width, height }),
    })
    setClient(started)
    started.start()
    return () => started.stop()
  }, [serial])

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
        client!.touch("down", gesture.x, gesture.y)
      }
      gesture = {
        x: clamp(gesture.x - (event.deltaX * scale) / bounds.width),
        y: clamp(gesture.y - (event.deltaY * scale) / bounds.height),
      }
      client!.touch("move", gesture.x, gesture.y)
      clearTimeout(release)
      release = setTimeout(() => {
        if (gesture !== undefined) client!.touch("up", gesture.x, gesture.y)
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
    (phase: "down" | "move" | "up") =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (phase === "down") {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        // Scrolling the page now would move the screen under the finger.
        event.currentTarget.focus({ preventScroll: true })
        pointerDown.current = true
      } else if (!pointerDown.current) {
        return
      }
      if (phase === "up") pointerDown.current = false
      const bounds = event.currentTarget.getBoundingClientRect()
      const { x, y } = pointIn(shownScreen(bounds, screen), event)
      client?.touch(phase, x, y)
    }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    const keycode = androidKeycodes[event.key]
    if (keycode !== undefined) {
      event.preventDefault()
      client?.key(keycode)
    } else if ([...event.key].length === 1) {
      // A character, Shift and Option already applied by the browser.
      event.preventDefault()
      client?.text(event.key)
    }
  }

  const ready = status.kind === "streaming"
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div
        ref={surface}
        {...{ [streamAttribute]: "" }}
        data-status={status.kind}
        data-transport="webrtc"
        tabIndex={0}
        role="application"
        aria-label={`${device.name} on the Device Host. Esc leaves the device.`}
        className="relative min-h-0 w-full shrink touch-none overflow-hidden rounded-[1.75rem] border bg-black outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50"
        style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
        onPointerDown={touch("down")}
        onPointerMove={touch("move")}
        onPointerUp={touch("up")}
        onPointerCancel={touch("up")}
        onKeyDown={keyDown}
      >
        <video
          ref={video}
          muted
          playsInline
          disablePictureInPicture
          className="pointer-events-none size-full object-contain"
        />
        <StreamOverlay
          status={status}
          device={device}
          onReconnect={onReconnect}
        />
      </div>
      <div className="flex justify-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={!ready}
          onClick={() => client?.press("back")}
        >
          <ArrowLeftIcon />
          Back
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={!ready}
          onClick={() => client?.press("home")}
        >
          <CircleIcon />
          Home
        </Button>
      </div>
    </div>
  )
}
