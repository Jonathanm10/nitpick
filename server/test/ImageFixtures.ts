// Ports the snapshot check of Tests/NitpickCoreTests/Support/ImageFixtures.swift:
// images compare on decoded pixels within a tolerance, never byte for byte.
import { createCanvas, loadImage } from "@napi-rs/canvas"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface DecodedImage {
  readonly width: number
  readonly height: number
  /** RGBA, 8 bits per channel. */
  readonly pixels: Uint8ClampedArray
}

export async function decodeRGBA(png: Uint8Array): Promise<DecodedImage> {
  const image = await loadImage(png)
  const context = createCanvas(image.width, image.height).getContext("2d")
  context.drawImage(image, 0, 0)
  const { data } = context.getImageData(0, 0, image.width, image.height)
  return { width: image.width, height: image.height, pixels: data }
}

export interface SnapshotComparison {
  readonly mismatched: number
  readonly total: number
  /** Red where a pixel is beyond the channel delta, the reference faded to light gray elsewhere. */
  readonly diff: Uint8Array
}

/**
 * Compares `actual` with `reference` as the Swift suite does: a pixel counts
 * as different when any channel differs by more than `maxChannelDelta`.
 * Throws when the dimensions differ.
 */
export async function compareToSnapshot(
  actual: Uint8Array,
  reference: Uint8Array,
  maxChannelDelta = 32
): Promise<SnapshotComparison> {
  const [got, expected] = await Promise.all([
    decodeRGBA(actual),
    decodeRGBA(reference),
  ])
  if (got.width !== expected.width || got.height !== expected.height) {
    throw new Error(
      `size ${got.width}×${got.height} ≠ reference ${expected.width}×${expected.height}`
    )
  }
  const diffCanvas = createCanvas(got.width, got.height)
  const diffContext = diffCanvas.getContext("2d")
  const diffPixels = diffContext.createImageData(got.width, got.height)
  let mismatched = 0
  for (let pixel = 0; pixel < got.pixels.length; pixel += 4) {
    let differs = false
    for (let channel = 0; channel < 4; channel++) {
      const delta = Math.abs(
        got.pixels[pixel + channel]! - expected.pixels[pixel + channel]!
      )
      if (delta > maxChannelDelta) differs = true
    }
    if (differs) mismatched++
    const [red, green, blue] = expected.pixels.subarray(pixel, pixel + 3)
    const faded = 255 - ((255 - (red! + green! + blue!) / 3) >> 2)
    diffPixels.data.set(
      differs ? [255, 0, 0, 255] : [faded, faded, faded, 255],
      pixel
    )
  }
  diffContext.putImageData(diffPixels, 0, 0)
  return {
    mismatched,
    total: got.width * got.height,
    diff: await diffCanvas.encode("png"),
  }
}

/** Writes `png` to the temporary directory and returns its path, for a failure message. */
export function writeCandidate(name: string, png: Uint8Array): string {
  const path = join(tmpdir(), `${name}-${crypto.randomUUID()}.png`)
  writeFileSync(path, png)
  return path
}
