// The iOS viewer's transport, after T3 Code's
// packages/client-runtime/src/device/stream.ts (MIT, github.com/pingdotgg/t3code
// at 36d4d71): H.264 from serve-sim's AVCC stream decoded with WebCodecs,
// MJPEG where the browser can't decode it, and touch and keys on the
// helper's input socket. Everything goes through the server's proxy.
import {
  AvccDemuxer,
  avcCodecString,
  homeButtonMessage,
  inputAdmittedTag,
  keyMessage,
  screenConfigTag,
  simulatorAvcConfig,
  touchMessage,
} from "@nitpick/core"

export type DeviceStreamStatus =
  | { readonly kind: "connecting" }
  | { readonly kind: "streaming" }
  | { readonly kind: "failed"; readonly message: string }
  /** The proxy no longer takes the browser's cookie. */
  | { readonly kind: "unauthorized" }

export interface DeviceStreamEvents {
  readonly onStatus: (status: DeviceStreamStatus) => void
  /** The device's screen in pixels, from the input socket. */
  readonly onScreen: (width: number, height: number) => void
  /**
   * H.264 can't be decoded here (WebCodecs needs a secure context, which
   * plain HTTP on the LAN isn't), so the owner shows an `<img>` of this URL
   * instead of the canvas and hands it to `watchMjpegImage`.
   */
  readonly onMjpeg: (url: string) => void
}

export interface DeviceStreamClient {
  readonly start: () => void
  readonly stop: () => void
  readonly watchMjpegImage: (image: HTMLImageElement | null) => void
  /** A touch at a point of the displayed frame, each coordinate 0 to 1. */
  readonly touch: (
    phase: "begin" | "move" | "end",
    x: number,
    y: number
  ) => void
  readonly key: (phase: "down" | "up", usage: number) => void
  readonly pressHome: () => void
}

const hubBase = "/api/device-hub/vendor/serve-sim"
const retryDelay = 1_000
const firstFrameTimeout = 15_000
const mjpegFrameCheck = 250
const frameDurationMicroseconds = 16_667
const softDecodeQueue = 8

const canDecodeVideo = () =>
  "VideoDecoder" in globalThis && "EncodedVideoChunk" in globalThis

export function createDeviceStreamClient(
  udid: string,
  canvas: HTMLCanvasElement,
  events: DeviceStreamEvents
): DeviceStreamClient {
  const device = encodeURIComponent(udid)
  const avccURL = `${hubBase}/helper/${device}/stream.avcc`
  const mjpegURL = `${hubBase}/helper/${device}/stream.mjpeg`
  const socketURL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${hubBase}/helper/ws?device=${device}`

  let stopped = true
  let generation = 0
  let socket: WebSocket | null = null
  let inputAdmitted = false
  let video: AbortController | null = null
  let decoder: VideoDecoder | null = null
  let decodedFrame = false
  let awaitingKeyframe = true
  let timestamp = 0
  let firstFrame = false
  let mjpeg = false
  let mjpegImage: HTMLImageElement | null = null
  let releaseImage: (() => void) | null = null
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined
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

  const connecting = () => {
    firstFrame = false
    clearTimeout(firstFrameTimer)
    firstFrameTimer = setTimeout(
      () => fail("No video came from the device. Reconnect to try again."),
      firstFrameTimeout
    )
    status({ kind: "connecting" })
  }

  const frameShown = () => {
    if (firstFrame) return
    firstFrame = true
    clearTimeout(firstFrameTimer)
    status({ kind: "streaming" })
  }

  const retry = (run: () => void) => {
    if (stopped) return
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      run()
    }, retryDelay)
    retryTimers.add(timer)
  }

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (stopped) return
    const context = canvas.getContext("2d")
    if (context === null) {
      fail("This browser can't draw the device stream.")
      return
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.drawImage(source, 0, 0, width, height)
    frameShown()
  }

  const closeDecoder = () => {
    try {
      decoder?.close()
    } catch {
      // Already closed by an error.
    }
    decoder = null
    awaitingKeyframe = true
  }

  const fallBackToMjpeg = () => {
    if (stopped || mjpeg) return
    mjpeg = true
    video?.abort()
    video = null
    closeDecoder()
    connecting()
    events.onMjpeg(mjpegURL)
    watchImage()
  }

  // An <img> fires `load` for a multipart body only once it ends, so the
  // first frame shows as the image gaining a size.
  const watchImage = () => {
    releaseImage?.()
    releaseImage = null
    const image = mjpegImage
    if (image === null || stopped || !mjpeg) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      if (image.naturalWidth > 0) frameShown()
      else timer = setTimeout(check, mjpegFrameCheck)
    }
    const failed = () =>
      fail("The device stream stopped. Reconnect to try again.")
    image.addEventListener("load", check)
    image.addEventListener("error", failed)
    releaseImage = () => {
      clearTimeout(timer)
      image.removeEventListener("load", check)
      image.removeEventListener("error", failed)
      image.removeAttribute("src")
    }
    image.src = mjpegURL
    check()
  }

  const configure = async (description: Uint8Array): Promise<boolean> => {
    const config: VideoDecoderConfig = {
      codec: avcCodecString(description),
      description: simulatorAvcConfig(description),
      optimizeForLatency: true,
    }
    const support = await VideoDecoder.isConfigSupported(config).catch(() => ({
      supported: false,
    }))
    if (!support.supported || stopped) return false
    try {
      if (decoder === null || decoder.state === "closed") {
        const current = new VideoDecoder({
          output: (frame) => {
            try {
              if (decoder === current) {
                decodedFrame = true
                paint(frame, frame.displayWidth, frame.displayHeight)
              }
            } finally {
              frame.close()
            }
          },
          error: () => {
            if (decoder === current) fallBackToMjpeg()
          },
        })
        decoder = current
      }
      decoder.configure(config)
      return true
    } catch {
      return false
    }
  }

  const decode = (isKey: boolean, data: Uint8Array) => {
    if (decoder?.state !== "configured") return
    if (awaitingKeyframe) {
      if (!isKey) return
      awaitingKeyframe = false
    }
    // An idle simulator may take minutes to send its next keyframe; a new
    // subscription forces one.
    if (decoder.decodeQueueSize > softDecodeQueue) {
      video?.abort()
      return
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? "key" : "delta",
          timestamp,
          data,
        })
      )
      timestamp += frameDurationMicroseconds
    } catch {
      fallBackToMjpeg()
    }
  }

  const readVideo = async () => {
    const session = generation
    const controller = new AbortController()
    video = controller
    const current = () =>
      !stopped && generation === session && video === controller
    const demuxer = new AvccDemuxer()
    try {
      const response = await fetch(avccURL, { signal: controller.signal })
      if (!current()) return
      if (response.status === 401) return unauthorized()
      if (!response.ok || response.body === null) {
        throw new Error(`stream ${response.status}`)
      }
      const reader = response.body.getReader()
      for (;;) {
        // An AVCC body can stay open after its helper stops producing frames.
        const stall = setTimeout(() => controller.abort(), firstFrameTimeout)
        const { done, value } = await reader
          .read()
          .finally(() => clearTimeout(stall))
        if (!current() || done) break
        for (const chunk of demuxer.push(value)) {
          switch (chunk.type) {
            case "seed":
              // A still screen sends no frame until it changes; the seed
              // shows it at once.
              void createImageBitmap(
                new Blob([chunk.payload as BlobPart], { type: "image/jpeg" })
              )
                .then((bitmap) => {
                  if (current() && !decodedFrame) {
                    paint(bitmap, bitmap.width, bitmap.height)
                  }
                  bitmap.close()
                })
                .catch(() => {})
              break
            case "description":
              awaitingKeyframe = true
              if (!(await configure(chunk.payload))) {
                await reader.cancel().catch(() => {})
                if (current()) fallBackToMjpeg()
                return
              }
              break
            case "keyframe":
            case "delta":
              decode(chunk.type === "keyframe", chunk.payload)
              break
          }
        }
      }
    } catch {
      // Reconnected below.
    }
    if (current()) {
      video = null
      closeDecoder()
      retry(() => void readVideo())
    }
  }

  /**
   * serve-sim's helper takes input and reports its screen only once screen
   * capture runs, which reading the MJPEG endpoint starts reliably.
   */
  const primeHelper = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetch(mjpegURL, { signal: controller.signal })
      if (response.status === 401) return false
      await response.body?.getReader().read()
    } catch {
      // The socket's own retries take over.
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    return true
  }

  const connectInput = async () => {
    const session = generation
    if (!(await primeHelper())) return unauthorized()
    if (stopped || generation !== session) return
    const opened = new WebSocket(socketURL)
    opened.binaryType = "arraybuffer"
    socket = opened
    inputAdmitted = false
    opened.onmessage = (event) => {
      if (socket !== opened || !(event.data instanceof ArrayBuffer)) return
      const bytes = new Uint8Array(event.data)
      if (bytes[0] === inputAdmittedTag) {
        inputAdmitted = true
      } else if (bytes[0] === screenConfigTag) {
        try {
          const config = JSON.parse(
            new TextDecoder().decode(bytes.subarray(1))
          ) as { width?: unknown; height?: unknown }
          if (
            typeof config.width === "number" &&
            typeof config.height === "number" &&
            config.width > 0 &&
            config.height > 0
          ) {
            events.onScreen(config.width, config.height)
          }
        } catch {
          // Not a screen this viewer can size to.
        }
      }
    }
    opened.onclose = () => {
      if (socket !== opened) return
      socket = null
      inputAdmitted = false
      retry(() => void connectInput())
    }
    opened.onerror = () => opened.close()
  }

  const send = (message: Uint8Array) => {
    if (!stopped && inputAdmitted && socket?.readyState === WebSocket.OPEN) {
      socket.send(message as Uint8Array<ArrayBuffer>)
    }
  }

  const start = () => {
    if (!stopped) return
    stopped = false
    generation++
    mjpeg = false
    decodedFrame = false
    connecting()
    void connectInput()
    if (canDecodeVideo()) void readVideo()
    else fallBackToMjpeg()
  }

  function stop() {
    if (stopped) return
    stopped = true
    generation++
    clearTimeout(firstFrameTimer)
    for (const timer of retryTimers) clearTimeout(timer)
    retryTimers.clear()
    releaseImage?.()
    releaseImage = null
    video?.abort()
    video = null
    closeDecoder()
    const closing = socket
    socket = null
    closing?.close()
  }

  return {
    start,
    stop,
    watchMjpegImage(image) {
      if (mjpegImage === image) return
      mjpegImage = image
      watchImage()
    },
    touch: (phase, x, y) => send(touchMessage(phase, x, y)),
    key: (phase, usage) => send(keyMessage(phase, usage)),
    pressHome: () => send(homeButtonMessage()),
  }
}
