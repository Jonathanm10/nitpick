// The iOS stream's wire format, ported from T3 Code's
// packages/client-runtime/src/device/stream.ts and avcConfig.ts (MIT,
// github.com/pingdotgg/t3code at 36d4d71), iOS only. Pure, so the page's
// viewer and these tests share it.

/** One AVCC envelope from serve-sim's `stream.avcc`. */
export interface AvccChunk {
  /** A JPEG seed paints at once; the decoder waits for its description and a keyframe. */
  readonly type: "description" | "keyframe" | "delta" | "seed"
  readonly payload: Uint8Array
}

const avccTags: Record<number, AvccChunk["type"] | undefined> = {
  1: "description",
  2: "keyframe",
  3: "delta",
  4: "seed",
}

/** Splits the body into envelopes: a 4-byte length, a tag, the payload. */
export class AvccDemuxer {
  #buffer = new Uint8Array(64 * 1024)
  #length = 0

  push(bytes: Uint8Array): AvccChunk[] {
    if (this.#length + bytes.length > this.#buffer.length) {
      let capacity = this.#buffer.length
      while (capacity < this.#length + bytes.length) capacity *= 2
      const grown = new Uint8Array(capacity)
      grown.set(this.#buffer.subarray(0, this.#length))
      this.#buffer = grown
    }
    this.#buffer.set(bytes, this.#length)
    this.#length += bytes.length

    const chunks: AvccChunk[] = []
    let offset = 0
    while (this.#length - offset >= 4) {
      const view = new DataView(
        this.#buffer.buffer,
        this.#buffer.byteOffset + offset,
        4
      )
      const frameLength = view.getUint32(0, false)
      if (this.#length - offset - 4 < frameLength) break
      if (frameLength >= 1) {
        const type = avccTags[this.#buffer[offset + 4]!]
        if (type) {
          chunks.push({
            type,
            payload: this.#buffer.slice(offset + 5, offset + 4 + frameLength),
          })
        }
      }
      offset += 4 + frameLength
    }
    if (offset > 0) {
      this.#buffer.copyWithin(0, offset, this.#length)
      this.#length -= offset
    }
    return chunks
  }
}

/** The WebCodecs codec string an avcC record names. */
export function avcCodecString(bytes: Uint8Array): string {
  if (bytes.length < 4) return "avc1.42E01E"
  const hex = (byte: number) => byte.toString(16).padStart(2, "0")
  return `avc1.${hex(bytes[1]!)}${hex(bytes[2]!)}${hex(bytes[3]!)}`
}

const maxConfigBytes = 64 * 1024
const maxSPSBytes = 4096

const unsignedGolomb = (value: number) => {
  const bits = (value + 1).toString(2)
  return "0".repeat(bits.length - 1) + bits
}

function withReorderLimits(sps: Uint8Array): Uint8Array {
  if (sps.length < 4 || sps.length > maxSPSBytes || (sps[0]! & 0x9f) !== 7)
    return sps
  const rbsp: number[] = []
  let zeros = 0
  for (let index = 1; index < sps.length; index++) {
    const byte = sps[index]!
    if (zeros >= 2 && byte === 3) {
      if (index + 1 >= sps.length || sps[index + 1]! > 3) return sps
      zeros = 0
      continue
    }
    rbsp.push(byte)
    zeros = byte === 0 ? zeros + 1 : 0
  }
  const bits = rbsp.map((byte) => byte.toString(2).padStart(8, "0")).join("")
  let position = 0
  const read = (count: number) => {
    if (position + count > bits.length) throw new Error("Truncated H.264 SPS")
    const value = Number.parseInt(bits.slice(position, position + count), 2)
    position += count
    return value
  }
  const readUnsignedGolomb = () => {
    let leadingZeros = 0
    while (read(1) === 0) {
      if (++leadingZeros > 31) throw new Error("Invalid H.264 Exp-Golomb value")
    }
    return 2 ** leadingZeros - 1 + (leadingZeros === 0 ? 0 : read(leadingZeros))
  }

  try {
    // Only handle the hub's 8-bit 4:2:0 High profile without scaling lists.
    // Unknown encoder configurations pass through rather than guessing their layout.
    if (read(8) !== 100) return sps
    read(16)
    if (readUnsignedGolomb() > 31 || readUnsignedGolomb() !== 1) return sps
    if (readUnsignedGolomb() !== 0 || readUnsignedGolomb() !== 0) return sps
    read(1)
    if (read(1) !== 0) return sps
    if (readUnsignedGolomb() > 12) return sps
    const pictureOrderCountType = readUnsignedGolomb()
    if (pictureOrderCountType === 0) {
      if (readUnsignedGolomb() > 12) return sps
    } else if (pictureOrderCountType === 1) {
      read(1)
      readUnsignedGolomb()
      readUnsignedGolomb()
      const cycleLength = readUnsignedGolomb()
      if (cycleLength > 255) return sps
      for (let index = 0; index < cycleLength; index++) readUnsignedGolomb()
    } else if (pictureOrderCountType !== 2) return sps
    const maxReferenceFrames = readUnsignedGolomb()
    if (maxReferenceFrames > 16) return sps
    read(1)
    if (readUnsignedGolomb() > 65535 || readUnsignedGolomb() > 65535) return sps
    if (read(1) === 0) read(1)
    read(1)
    if (read(1) !== 0) {
      for (let index = 0; index < 4; index++) readUnsignedGolomb()
    }
    const vuiPosition = position
    if (read(1) !== 0) return sps
    // With no VUI, only rbsp_stop_one_bit and byte padding may follow.
    if (!/^10{0,7}$/.test(bits.slice(position))) return sps

    // serve-sim disables reordering, but its fallback encoder omits VUI, so Chromium
    // infers a large queue despite optimizeForLatency. Add VUI with zero reorder frames.
    // Flags omit eight optional sections and enable bitstream restrictions
    // and motion_vectors_over_pic_boundaries_flag.
    const restricted =
      bits.slice(0, vuiPosition) +
      "10000000011" +
      [2, 1, 16, 16, 0, maxReferenceFrames].map(unsignedGolomb).join("") +
      "1"
    const padded = restricted.padEnd(Math.ceil(restricted.length / 8) * 8, "0")
    const output = [sps[0]!]
    zeros = 0
    for (let index = 0; index < padded.length; index += 8) {
      const byte = Number.parseInt(padded.slice(index, index + 8), 2)
      if (zeros >= 2 && byte <= 3) {
        output.push(3)
        zeros = 0
      }
      output.push(byte)
      zeros = byte === 0 ? zeros + 1 : 0
    }
    return Uint8Array.from(output)
  } catch {
    return sps
  }
}

/** Repair missing reorder metadata only for serve-sim's non-reordering AVCC feed. */
export function simulatorAvcConfig(description: Uint8Array): Uint8Array {
  if (
    description.length < 7 ||
    description.length > maxConfigBytes ||
    description[0] !== 1
  )
    return description
  const parameterSets = description[5]! & 0x1f
  if (parameterSets === 0) return description
  const parts: Uint8Array[] = [description.subarray(0, 6)]
  let position = 6
  let changed = false
  for (let index = 0; index < parameterSets; index++) {
    if (position + 2 > description.length) return description
    const length = description[position]! * 256 + description[position + 1]!
    position += 2
    if (length === 0 || position + length > description.length)
      return description
    const sps = description.subarray(position, position + length)
    const repaired = withReorderLimits(sps)
    changed ||= repaired !== sps
    parts.push(
      Uint8Array.of(repaired.length >>> 8, repaired.length & 0xff),
      repaired
    )
    position += length
  }
  const suffix = position
  if (position >= description.length) return description
  const pictureParameterSets = description[position++]!
  for (let index = 0; index < pictureParameterSets; index++) {
    if (position + 2 > description.length) return description
    const length = description[position]! * 256 + description[position + 1]!
    position += 2
    if (length === 0 || position + length > description.length)
      return description
    position += length
  }
  if (!changed) return description
  parts.push(description.subarray(suffix))
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0)
  )
  position = 0
  for (const part of parts) {
    output.set(part, position)
    position += part.length
  }
  return output
}

// Input travels on the helper's socket as one tag byte and a JSON payload.
const touchTag = 0x03
const buttonTag = 0x04
const keyTag = 0x06
/** The helper's first frame on the socket: input is accepted from here on. */
export const inputAdmittedTag = 0x83
/** The helper's screen size and orientation, as JSON after the tag. */
export const screenConfigTag = 0x82

/** A touch at a point in the displayed frame, each coordinate from 0 to 1. */
export function touchMessage(
  phase: "begin" | "move" | "end",
  x: number,
  y: number
): Uint8Array {
  return taggedJSON(touchTag, { type: phase, x: unit(x), y: unit(y) })
}

/** A key going down or up, by its HID usage. */
export function keyMessage(phase: "down" | "up", usage: number): Uint8Array {
  return taggedJSON(keyTag, { type: phase, usage })
}

/** The Home button: the gesture that leaves the Build for the home screen. */
export function homeButtonMessage(): Uint8Array {
  return taggedJSON(buttonTag, { button: "home" })
}

const hidUsageByCode: Readonly<Record<string, number>> = {
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  Delete: 0x4c,
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
}

/**
 * The HID usage of a physical key, by `KeyboardEvent.code`, or undefined for
 * one the simulator's keyboard has no key for. The device maps it through
 * its own keyboard layout, as a hardware keyboard would be.
 */
export function hidUsage(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return 0x04 + (code.charCodeAt(3) - 65)
  if (/^Digit[1-9]$/.test(code)) return 0x1e + (code.charCodeAt(5) - 49)
  if (code === "Digit0") return 0x27
  return hidUsageByCode[code]
}

function unit(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** The payloads are ASCII JSON, so each character is one byte. */
function taggedJSON(tag: number, payload: unknown): Uint8Array {
  const json = JSON.stringify(payload)
  const bytes = new Uint8Array(1 + json.length)
  bytes[0] = tag
  for (let index = 0; index < json.length; index++) {
    bytes[index + 1] = json.charCodeAt(index)
  }
  return bytes
}
