// Not a port: T3 Code's mjpegStillFrame.ts has no test of its own; these
// pin the behaviour its comment promises.
import { describe, expect, test } from "vitest"
import { repeatStillFrame } from "../src/device/mjpegStillFrame.ts"
import { mjpegPart } from "./FakeDeviceHub.ts"

/** A hub body the test writes to chunk by chunk. */
function hubBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(start) {
      controller = start
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    body,
    write: (bytes: Uint8Array) => controller.enqueue(bytes),
    end: () => controller.close(),
    cancelled: () => cancelled,
  }
}

async function readFor(
  stream: ReadableStream<Uint8Array>,
  milliseconds: number
): Promise<Buffer> {
  const reader = stream.getReader()
  const received: Uint8Array[] = []
  const deadline = Date.now() + milliseconds
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) break
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = await Promise.race([
      reader.read(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), left)
      }),
    ])
    clearTimeout(timer)
    if (next === "timeout" || next.done) break
    received.push(next.value)
  }
  await reader.cancel()
  return Buffer.concat(received)
}

describe("MJPEG still frame", () => {
  test("a part followed by quiet is sent once more, then nothing until the screen changes", async () => {
    const hub = hubBody()
    const part = mjpegPart("frame-1")
    hub.write(part)

    const received = await readFor(repeatStillFrame(hub.body, 20), 200)

    expect(received).toEqual(Buffer.concat([part, part]))
  })

  test("a part split across writes is tracked and repeated whole", async () => {
    const hub = hubBody()
    const part = mjpegPart("frame-split-across-three-writes")
    hub.write(part.subarray(0, 10))
    hub.write(part.subarray(10, 40))
    hub.write(part.subarray(40))

    const received = await readFor(repeatStillFrame(hub.body, 20), 200)

    expect(received).toEqual(Buffer.concat([part, part]))
  })

  test("frames arriving faster than the quiet period are never repeated", async () => {
    const hub = hubBody()
    const parts = [mjpegPart("a"), mjpegPart("b"), mjpegPart("c")]
    const stream = repeatStillFrame(hub.body, 1_000)
    for (const part of parts) hub.write(part)
    hub.end()

    const received = await readFor(stream, 200)

    expect(received).toEqual(Buffer.concat(parts))
  })

  test("any other framing passes through and is never repeated", async () => {
    const hub = hubBody()
    const unknown = Buffer.from("not a multipart part\r\n\r\nat all")
    hub.write(unknown)

    const received = await readFor(repeatStillFrame(hub.body, 20), 200)

    expect(received).toEqual(unknown)
  })

  test("cancelling the stream cancels the hub's body", async () => {
    const hub = hubBody()
    hub.write(mjpegPart("frame"))
    const reader = repeatStillFrame(hub.body, 20).getReader()
    await reader.read()

    await reader.cancel()

    expect(hub.cancelled()).toBe(true)
  })
})
