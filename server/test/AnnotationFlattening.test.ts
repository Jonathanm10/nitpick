// Ports Tests/NitpickCoreTests/AnnotationFlatteningTests.swift, against the
// goldens the Swift app exported to core/test/golden/images. The metrics case
// is in core/test/AnnotationRendering.test.ts.
//
// Not ported: the Swift shell's live-preview path, which re-flattens a decoded
// capture on every edit (DecodedScreenshot reuse, the exclude-one render and
// compositing an overlay onto it). The server flattens once, at filing, and
// the browser previews by drawing on a canvas.
import { createCanvas, GlobalFonts } from "@napi-rs/canvas"
import {
  annotationMetrics,
  drawAnnotation,
  labelFont,
  translated,
  type Annotation,
} from "@nitpick/core"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import {
  annotatedScreenshotPNG,
  UnreadableScreenshot,
} from "../src/annotationFlattening.ts"
import {
  compareToSnapshot,
  decodeRGBA,
  writeCandidate,
} from "./ImageFixtures.ts"

const goldenImages = new URL("../../core/test/golden/images/", import.meta.url)

function golden(name: string): Uint8Array {
  return readFileSync(new URL(name, goldenImages))
}

function goldenInput(name: string): {
  capture: string
  annotations: Annotation[]
} {
  return JSON.parse(readFileSync(new URL(name, goldenImages), "utf8"))
}

// One of each tool, three palette colors beyond the default: the scene the
// snapshot pins, read from the description the Swift suite exported with it.
const fourTools = goldenInput("flattened-four-tools.input.json")
const capture = golden(fourTools.capture)

describe("Annotation flattening", () => {
  test("no Annotations: the annotated variant is the original, byte for byte", async () => {
    const passthrough = goldenInput("unannotated-passthrough.input.json")
    expect(passthrough.annotations).toEqual([])

    const flattened = await annotatedScreenshotPNG(
      golden(passthrough.capture),
      passthrough.annotations
    )

    expect(
      Buffer.compare(flattened, golden("unannotated-passthrough.png"))
    ).toBe(0)
  })

  test("flattening keeps native resolution and actually marks pixels", async () => {
    const flattened = await annotatedScreenshotPNG(
      capture,
      fourTools.annotations
    )

    expect(Buffer.compare(flattened, capture)).not.toBe(0)
    const decoded = await decodeRGBA(flattened)
    expect(decoded.width).toBe(480)
    expect(decoded.height).toBe(960)
    const original = await decodeRGBA(capture)
    expect(decoded.pixels).not.toEqual(original.pixels)
  })

  test("all four tools flatten as pinned by the reference snapshot", async () => {
    const flattened = await annotatedScreenshotPNG(
      capture,
      fourTools.annotations
    )

    const { mismatched, total, diff } = await compareToSnapshot(
      flattened,
      golden("flattened-four-tools.png")
    )

    // At most 0.05% of the pixels: smaller than the smallest single mark, the
    // label at about 0.09%, so losing any one Annotation fails.
    if (mismatched / total > 0.0005) {
      expect.fail(
        `core/test/golden/images/flattened-four-tools.png: ${mismatched} of ${total} pixels beyond ±32. ` +
          `Candidate at ${writeCandidate("flattened-four-tools", flattened)}, ` +
          `diff at ${writeCandidate("flattened-four-tools-diff", diff)}.`
      )
    }
  })

  test("an unreadable screenshot is a thrown error, not a crash", async () => {
    const unreadable = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const rectangle: Annotation = {
      kind: "rectangle",
      color: "red",
      rect: { x: 0, y: 0, width: 10, height: 10 },
    }

    const flattening = annotatedScreenshotPNG(unreadable, [rectangle])

    await expect(flattening).rejects.toBeInstanceOf(UnreadableScreenshot)
    await expect(flattening).rejects.toThrow(
      "The capture could not be read as an image, so Annotations cannot be flattened."
    )
  })

  // The browser drags a shape by shifting its once-drawn image by whole pixels
  // (the Swift shell's overlay). That is honest only if drawing is
  // translation-invariant on the pixel lattice, for every shape kind.
  test.each(fourTools.annotations)(
    "rendering alone shifts exactly with a whole-pixel translation: $kind",
    (annotation) => {
      const size = { width: 480, height: 960 }
      const [deltaX, deltaY] = [7, -5]
      const render = (shape: Annotation) => {
        const context = createCanvas(size.width, size.height).getContext("2d")
        drawAnnotation(context, shape, annotationMetrics(size))
        return context.getImageData(0, 0, size.width, size.height).data
      }
      const original = render(annotation)
      const shifted = render(translated(annotation, { dx: deltaX, dy: deltaY }))

      let mismatched = 0
      for (let row = 0; row < size.height; row++) {
        const sourceRow = row - deltaY
        if (sourceRow < 0 || sourceRow >= size.height) continue
        for (let column = 0; column < size.width; column++) {
          const sourceColumn = column - deltaX
          if (sourceColumn < 0 || sourceColumn >= size.width) continue
          const shiftedPixel = (row * size.width + column) * 4
          const originalPixel = (sourceRow * size.width + sourceColumn) * 4
          for (let channel = 0; channel < 4; channel++) {
            if (
              shifted[shiftedPixel + channel] !==
              original[originalPixel + channel]
            ) {
              mismatched++
            }
          }
        }
      }
      expect(original.some((value) => value !== 0)).toBe(true)
      expect(mismatched).toBe(0)
    }
  )

  // Not in the Swift suite. The label draws and measures in Helvetica Bold,
  // which macOS ships, so this suite runs on a Mac, as the server does. Label
  // hit-testing measures with a canvas, and CoreText gives "2pt off" in 17 pt
  // Helvetica Bold an advance of 51.9296875.
  test("the server has Helvetica and measures labels as CoreText does", () => {
    expect(GlobalFonts.has("Helvetica")).toBe(true)
    const context = createCanvas(1, 1).getContext("2d")
    context.font = labelFont(annotationMetrics({ width: 480, height: 960 }))

    expect(context.measureText("2pt off").width).toBeCloseTo(51.9296875, 4)
  })
})
