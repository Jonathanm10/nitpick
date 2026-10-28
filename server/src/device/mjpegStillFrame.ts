// Ported from T3 Code's apps/server/src/device/mjpegStillFrame.ts (MIT,
// github.com/pingdotgg/t3code at 36d4d71), from Effect streams to web streams.

/**
 * Browsers paint a multipart/x-mixed-replace part only once the next part
 * begins, and the hub writes a part only when the screen changes. Left
 * alone, an `<img>` viewer never shows a still screen and always hides the
 * last frame of a change. Re-sending the last part after a short quiet
 * period makes it paint.
 */
export const stillFrameDelayMilliseconds = 100

const headerEnd = Buffer.from("\r\n\r\n")
const maxHeaderBytes = 16 * 1024
// Simulator frames are far smaller; a larger claim is unknown framing, not something to retain.
const maxPartBytes = 16 * 1024 * 1024

type Part = ReadonlyArray<Uint8Array>

function partLength(headers: string): number | undefined {
  if (!headers.startsWith("--")) return undefined
  const length = Number(/^content-length:\s*(\d+)\s*$/im.exec(headers)?.[1])
  return length <= maxPartBytes ? length : undefined
}

function endsWithCRLF(part: Part): boolean {
  const last = part.at(-1)!
  const cr = last.length > 1 ? last.at(-2) : part.at(-2)?.at(-1)
  return cr === 0x0d && last.at(-1) === 0x0a
}

/**
 * Follows the hub's part framing (`--frame`, `Content-Length`, CRLF CRLF,
 * body, CRLF; each part is one write) and keeps the last complete part as
 * views into the forwarded chunks, so frame bytes are never copied. Any
 * other framing turns tracking off and the rest passes through.
 */
function partTracker() {
  let pieces: Uint8Array[] = []
  let size = 0
  let partEnd: number | null = null
  let tracking = true
  return {
    /** The last complete part, while the stream sits at a part boundary. */
    still: null as Part | null,
    feed(chunk: Uint8Array) {
      if (!tracking) return
      let rest = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      let part: Part | undefined
      while (rest.length > 0) {
        if (partEnd === null) {
          // A header split across chunks is re-scanned per chunk. Only a
          // header-sized prefix of the new chunk joins the scan, so frame
          // bytes are never copied.
          const head =
            size === 0
              ? rest
              : Buffer.concat([
                  ...pieces,
                  rest.subarray(0, maxHeaderBytes + headerEnd.length),
                ])
          const end = head.indexOf(headerEnd)
          if (end < 0 && head.length <= maxHeaderBytes) {
            pieces.push(rest)
            size += rest.length
            break
          }
          const length =
            end < 0 || end > maxHeaderBytes
              ? undefined
              : partLength(head.subarray(0, end).toString("latin1"))
          if (length === undefined) {
            tracking = false
            break
          }
          partEnd = end + headerEnd.length + length + 2
        }
        const taken = rest.subarray(0, partEnd - size)
        pieces.push(taken)
        size += taken.length
        rest = rest.subarray(taken.length)
        if (size < partEnd) break
        const complete = pieces
        if (complete.length === 0 || !endsWithCRLF(complete)) {
          tracking = false
          break
        }
        part = complete
        pieces = []
        size = 0
        partEnd = null
      }
      if (!tracking) pieces = []
      this.still = tracking && size === 0 ? (part ?? this.still) : null
    },
  }
}

const quiet = Symbol("quiet")

type ReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
>

/** Re-sends the latest frame once when the stream goes quiet between frames. */
export function repeatStillFrame(
  body: ReadableStream<Uint8Array>,
  delayMilliseconds = stillFrameDelayMilliseconds
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  const tracker = partTracker()
  // A read the quiet period outlasted stays pending, so a frame arriving
  // mid-wait is kept for the next pull.
  let pending: Promise<ReadResult> | null = null
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pending === null) {
          pending = reader.read()
          // Its failure surfaces at the next pull; meanwhile it isn't unhandled.
          pending.catch(() => {})
        }
        const still = tracker.still
        let result: ReadResult | typeof quiet
        if (still === null) {
          result = await pending
        } else {
          let timer: ReturnType<typeof setTimeout> | undefined
          result = await Promise.race([
            pending,
            new Promise<typeof quiet>((resolve) => {
              timer = setTimeout(() => resolve(quiet), delayMilliseconds)
            }),
          ])
          clearTimeout(timer)
          if (result === quiet) {
            tracker.still = null
            for (const piece of still) controller.enqueue(piece)
            return
          }
        }
        pending = null
        if (result.done) {
          controller.close()
          return
        }
        tracker.feed(result.value)
        controller.enqueue(result.value)
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    },
    { highWaterMark: 0 }
  )
}
