// The Android viewer's transport: serve-emu's H.264 over WebRTC into a
// <video>, which browsers decode without a secure context, so plain HTTP on
// the LAN shows it (PRD answer 6); gestures and keys as JSON on serve-emu's
// input socket. Signaling and input go through the server's proxy; the
// media itself flows from the Device Host to the browser over the
// connection the authenticated offer set up.
import type { DeviceStreamStatus } from "@/lib/device-stream"

export interface EmulatorStreamEvents {
  readonly onStatus: (status: DeviceStreamStatus) => void
  /** The video's size in pixels, which gives the screen's shape. */
  readonly onScreen: (width: number, height: number) => void
}

export interface EmulatorStreamClient {
  readonly start: () => void
  readonly stop: () => void
  /** A finger at a point of the displayed screen, each coordinate 0 to 1. */
  readonly touch: (phase: "down" | "move" | "up", x: number, y: number) => void
  /** Typed characters, as Android's keyboard would enter them. */
  readonly text: (text: string) => void
  /** A press of an Android key, by its KeyEvent keycode. */
  readonly key: (keycode: number) => void
  readonly press: (button: "back" | "home") => void
}

const hubBase = "/api/device-hub/vendor/serve-emu"
const retryDelay = 1_000
const firstFrameTimeout = 15_000
/**
 * serve-emu takes one offer with every candidate, never trickled. A LAN
 * needs only host candidates, which come at once; some engines never report
 * the gathering complete, so the offer goes after this at the latest.
 */
const gatheringTimeout = 1_500
/** How often the viewer looks for the browser's keyframe requests. */
const keyframeWatchInterval = 500

export function createEmulatorStreamClient(
  serial: string,
  video: HTMLVideoElement,
  events: EmulatorStreamEvents
): EmulatorStreamClient {
  const device = encodeURIComponent(serial)
  const socketURL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${hubBase}/ws?device=${device}`

  let stopped = true
  let generation = 0
  let peer: { connection: RTCPeerConnection; sessionId: string } | null = null
  let socket: WebSocket | null = null
  let firstFrame = false
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined
  let keyframeWatch: ReturnType<typeof setInterval> | undefined
  const retryTimers = new Set<ReturnType<typeof setTimeout>>()

  const status = (next: DeviceStreamStatus) => {
    if (!stopped) events.onStatus(next)
  }

  const fail = (message: string) => {
    if (stopped) return
    events.onStatus({ kind: "failed", message })
    stop()
  }

  const unauthorized = () => {
    if (stopped) return
    events.onStatus({ kind: "unauthorized" })
    stop()
  }

  const retry = (run: () => void) => {
    if (stopped) return
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      run()
    }, retryDelay)
    retryTimers.add(timer)
  }

  const signal = (path: "offer" | "close", body: unknown, keepalive = false) =>
    fetch(`${hubBase}/webrtc/${path}?device=${device}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    })

  const closePeer = () => {
    const closing = peer
    peer = null
    if (closing === null) return
    closing.connection.close()
    void signal("close", { sessionId: closing.sessionId }, true).catch(() => {})
  }

  const frameShown = () => {
    if (video.videoWidth === 0) return
    events.onScreen(video.videoWidth, video.videoHeight)
    if (firstFrame) return
    firstFrame = true
    clearTimeout(firstFrameTimer)
    status({ kind: "streaming" })
  }
  video.addEventListener("resize", frameShown)
  video.addEventListener("loadeddata", frameShown)

  const connectVideo = async () => {
    const session = generation
    const current = () => !stopped && generation === session
    const connection = new RTCPeerConnection()
    const sessionId = randomUUID()
    peer = { connection, sessionId }
    connection.addTransceiver("video", { direction: "recvonly" })
    connection.ontrack = (event) => {
      video.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void video.play().catch(() => {})
    }
    connection.onconnectionstatechange = () => {
      const state = connection.connectionState
      if (
        current() &&
        peer?.connection === connection &&
        (state === "failed" || state === "disconnected")
      ) {
        closePeer()
        retry(() => void connectVideo())
      }
    }
    try {
      await connection.setLocalDescription(await connection.createOffer())
      await gathered(connection)
      if (!current()) return
      const response = await signal("offer", {
        type: "offer",
        sdp: connection.localDescription?.sdp,
        sessionId,
        codec: "h264",
      })
      if (!current()) return
      if (response.status === 401) return unauthorized()
      const answer = (await response.json().catch(() => undefined)) as
        { sdp?: string; message?: string } | undefined
      if (!response.ok || typeof answer?.sdp !== "string") {
        // A stream still starting answers 503; it settles on a retry.
        if (response.status === 503) {
          closePeer()
          retry(() => void connectVideo())
          return
        }
        return fail(
          answer?.message ?? `The device stream failed (${response.status}).`
        )
      }
      await connection.setRemoteDescription({ type: "answer", sdp: answer.sdp })
    } catch {
      if (!current()) return
      closePeer()
      retry(() => void connectVideo())
    }
  }

  /**
   * A screen change sends a burst of packets, and one lost from a frame
   * leaves the picture frozen: the browser asks for a keyframe with a PLI,
   * which serve-emu's publisher ignores, and a still screen sends no new
   * frame. Each new PLI goes to serve-emu as the keyframe request its input
   * socket takes instead.
   */
  const watchKeyframeRequests = () => {
    let requested = 0
    clearInterval(keyframeWatch)
    keyframeWatch = setInterval(() => {
      const connection = peer?.connection
      if (connection === undefined) return
      void connection.getStats().then((report) => {
        let count = 0
        report.forEach(
          (entry: {
            type: string
            kind?: string
            pliCount?: number
            firCount?: number
          }) => {
            if (entry.type === "inbound-rtp" && entry.kind === "video") {
              count = (entry.pliCount ?? 0) + (entry.firCount ?? 0)
            }
          }
        )
        if (count > requested) send({ type: "reset-video" })
        requested = count
      })
    }, keyframeWatchInterval)
  }

  const connectInput = () => {
    const session = generation
    const opened = new WebSocket(socketURL)
    socket = opened
    opened.onclose = () => {
      if (socket !== opened) return
      socket = null
      if (generation === session) retry(connectInput)
    }
    opened.onerror = () => opened.close()
  }

  const send = (message: Record<string, unknown>) => {
    if (!stopped && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  const start = () => {
    if (!stopped) return
    stopped = false
    generation++
    firstFrame = false
    clearTimeout(firstFrameTimer)
    firstFrameTimer = setTimeout(
      () => fail("No video came from the device. Reconnect to try again."),
      firstFrameTimeout
    )
    status({ kind: "connecting" })
    connectInput()
    void connectVideo()
    watchKeyframeRequests()
  }

  function stop() {
    if (stopped) return
    stopped = true
    generation++
    clearTimeout(firstFrameTimer)
    clearInterval(keyframeWatch)
    for (const timer of retryTimers) clearTimeout(timer)
    retryTimers.clear()
    closePeer()
    video.srcObject = null
    const closing = socket
    socket = null
    closing?.close()
  }

  return {
    start,
    stop,
    touch: (action, x, y) => send({ type: "touch", action, x, y }),
    text: (text) => send({ type: "text", text }),
    key: (keycode) => send({ type: "key", keycode }),
    press: (button) => send({ type: button }),
  }
}

/** Waits for ICE gathering to finish, or for `gatheringTimeout`. */
function gathered(connection: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (connection.iceGatheringState === "complete") return resolve()
    const timer = setTimeout(resolve, gatheringTimeout)
    connection.addEventListener("icegatheringstatechange", () => {
      if (connection.iceGatheringState !== "complete") return
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * A version 4 UUID for serve-emu's session. `crypto.randomUUID` needs a
 * secure context, which plain HTTP on the LAN isn't; random values don't.
 */
function randomUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"))
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-")
}

/**
 * The Android keycodes for the keys a browser reports by name; printable
 * characters go as text instead (android.view.KeyEvent).
 */
export const androidKeycodes: Readonly<Record<string, number>> = {
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Delete: 112,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
}
