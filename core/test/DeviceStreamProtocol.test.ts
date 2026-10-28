// Ports T3 Code's packages/client-runtime/src/device/avcConfig.test.ts and the
// AvccDemuxer cases of stream.test.ts (MIT, github.com/pingdotgg/t3code at
// 36d4d71); the input messages are new, checked against the bytes serve-sim
// took on a live simulator.
import { describe, expect, test } from "vitest"
import {
  AvccDemuxer,
  avcCodecString,
  hidUsage,
  homeButtonMessage,
  keyMessage,
  simulatorAvcConfig,
  touchMessage,
} from "../src/deviceStreamProtocol.ts"

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ]
}

describe("AvccDemuxer (stream.test.ts)", () => {
  test("reassembles envelopes split across reads", () => {
    const demuxer = new AvccDemuxer()
    const bytes = new Uint8Array([
      ...envelope(1, [1, 0x64, 0x00, 0x1f]),
      ...envelope(2, [9, 9, 9]),
      ...envelope(0x7f, [0]),
      ...envelope(3, [4]),
    ])
    const first = demuxer.push(bytes.subarray(0, 7))
    const rest = demuxer.push(bytes.subarray(7))
    const chunks = [...first, ...rest]
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "description",
      "keyframe",
      "delta",
    ])
    expect(Array.from(chunks[0]!.payload)).toEqual([1, 0x64, 0x00, 0x1f])
    expect(Array.from(chunks[1]!.payload)).toEqual([9, 9, 9])
  })

  test("derives the WebCodecs codec string from the avcC record", () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x1f]))).toBe(
      "avc1.64001f"
    )
    expect(avcCodecString(new Uint8Array([1]))).toBe("avc1.42E01E")
  })
})

// Captured from the hub before and after its encoder falls back from low-latency rate control.
const lowLatency = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 22, 39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20,
  158, 106, 154, 129, 1, 1, 3, 194, 1, 8, 248, 1, 0, 4, 40, 238, 60, 176,
])
const fallback = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230,
  164, 1, 0, 4, 40, 238, 60, 176,
])
const repaired = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230,
  168, 6, 208, 68, 35, 80, 1, 0, 4, 40, 238, 60, 176,
])

describe("simulator AVC reorder metadata (avcConfig.test.ts)", () => {
  test("adds zero reordering and one reference frame to the captured fallback SPS", () => {
    expect(simulatorAvcConfig(fallback)).toEqual(repaired)
    expect(simulatorAvcConfig(repaired)).toBe(repaired)
  })

  test("preserves existing VUI and leaves the original codec description untouched", () => {
    const original = fallback.slice()
    simulatorAvcConfig(fallback)
    expect(fallback).toEqual(original)
    expect(simulatorAvcConfig(lowLatency)).toBe(lowLatency)
  })

  test("repairs multiple SPS entries while preserving PPS and profile extensions", () => {
    const extensions = [0xfd, 0xf8, 0xf8, 0]
    const description = Uint8Array.from([
      ...fallback.subarray(0, 5),
      0xe2,
      ...fallback.subarray(6, 20),
      ...lowLatency.subarray(6, 30),
      ...fallback.subarray(20),
      ...extensions,
    ])
    expect(simulatorAvcConfig(description)).toEqual(
      Uint8Array.from([
        ...description.subarray(0, 6),
        ...repaired.subarray(6, 25),
        ...lowLatency.subarray(6, 30),
        ...fallback.subarray(20),
        ...extensions,
      ])
    )
  })

  test("passes through every truncated prefix of the captured configurations", () => {
    for (const config of [fallback, lowLatency]) {
      for (let length = 0; length < config.length; length++) {
        const truncated = config.subarray(0, length)
        expect(simulatorAvcConfig(truncated)).toBe(truncated)
      }
    }
  })

  test("does not modify unsupported profiles, scaling lists, or invalid parameter-set lengths", () => {
    const unsupportedProfile = fallback.slice()
    unsupportedProfile[9] = 110
    const scalingLists = fallback.slice()
    scalingLists[12] = scalingLists[12]! | 1
    const invalidSpsLength = fallback.slice()
    invalidSpsLength[6] = 0xff
    const invalidPpsLength = fallback.slice()
    invalidPpsLength[21] = 0xff
    for (const config of [
      unsupportedProfile,
      scalingLists,
      invalidSpsLength,
      invalidPpsLength,
    ]) {
      expect(simulatorAvcConfig(config)).toBe(config)
    }
  })

  test("requires valid SPS trailing bits before appending VUI metadata", () => {
    const invalidPadding = fallback.slice()
    invalidPadding[19] = 0
    expect(simulatorAvcConfig(invalidPadding)).toBe(invalidPadding)
  })

  test("passes through invalid NAL headers and unterminated Exp-Golomb values", () => {
    const forbiddenBit = fallback.slice()
    forbiddenBit[8] = forbiddenBit[8]! | 0x80
    expect(simulatorAvcConfig(forbiddenBit)).toBe(forbiddenBit)
    const unterminated = fallback.slice()
    unterminated.fill(0, 12, 20)
    expect(simulatorAvcConfig(unterminated)).toBe(unterminated)
    const overlong = Uint8Array.from([
      ...fallback.subarray(0, 6),
      0,
      13,
      39,
      100,
      0,
      51,
      0,
      0,
      3,
      0,
      0,
      3,
      0,
      0,
      0,
      ...fallback.subarray(20),
    ])
    expect(simulatorAvcConfig(overlong)).toBe(overlong)
  })

  test("bounds parsing of oversized configurations and SPS data", () => {
    const oversizedConfig = new Uint8Array(64 * 1024 + 1)
    oversizedConfig.set(fallback)
    expect(simulatorAvcConfig(oversizedConfig)).toBe(oversizedConfig)
    const oversizedSps = new Uint8Array(6 + 2 + 4097 + 7)
    oversizedSps.set(fallback.subarray(0, 6))
    oversizedSps.set([0x10, 1], 6)
    oversizedSps.set(fallback.subarray(8, 20), 8)
    oversizedSps.set(fallback.subarray(20), 8 + 4097)
    expect(simulatorAvcConfig(oversizedSps)).toBe(oversizedSps)
  })
})

const text = (bytes: Uint8Array) => String.fromCharCode(...bytes.subarray(1))

describe("serve-sim input messages", () => {
  test("a touch is tag 0x03 and its phase and point, clamped to the frame", () => {
    const message = touchMessage("begin", 0.5, 1.2)

    expect(message[0]).toBe(0x03)
    expect(JSON.parse(text(message))).toEqual({ type: "begin", x: 0.5, y: 1 })
  })

  test("a key is tag 0x06 and its HID usage", () => {
    const message = keyMessage("down", hidUsage("KeyH")!)

    expect(message[0]).toBe(0x06)
    expect(JSON.parse(text(message))).toEqual({ type: "down", usage: 0x0b })
  })

  test("Home is tag 0x04", () => {
    const message = homeButtonMessage()

    expect(message[0]).toBe(0x04)
    expect(JSON.parse(text(message))).toEqual({ button: "home" })
  })

  test.each([
    ["KeyA", 0x04],
    ["KeyZ", 0x1d],
    ["Digit1", 0x1e],
    ["Digit9", 0x26],
    ["Digit0", 0x27],
    ["Space", 0x2c],
    ["Enter", 0x28],
    ["Backspace", 0x2a],
    ["ShiftLeft", 0xe1],
    ["ArrowUp", 0x52],
  ])("%s is HID usage %i", (code, usage) => {
    expect(hidUsage(code)).toBe(usage)
  })

  test("a key the simulator's keyboard lacks has no usage", () => {
    expect(hidUsage("F13")).toBeUndefined()
    expect(hidUsage("Numpad5")).toBeUndefined()
  })
})
