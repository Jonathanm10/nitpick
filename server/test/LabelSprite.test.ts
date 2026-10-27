// Not a port: the Swift app previewed with the renderer it flattened with.
// The browser takes a label's glyphs from the server, so a label drawn from
// its sprite must be the flattened label, whatever the label's subpixel
// position, colour or text.
import { createCanvas, loadImage } from "@napi-rs/canvas"
import {
  annotationMetrics,
  labelSpriteLayout,
  type Annotation,
} from "@nitpick/core"
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import {
  annotatedScreenshotPNG,
  labelSpritePNG,
} from "../src/annotationFlattening.ts"
import { compareToSnapshot, decodeRGBA } from "./ImageFixtures.ts"

const capture = readFileSync(
  new URL("../../core/test/golden/images/capture.png", import.meta.url)
)

/** The capture with each label's sprite drawn where labelSpriteLayout says. */
async function composited(
  labels: Extract<Annotation, { kind: "label" }>[]
): Promise<Uint8Array> {
  const image = await loadImage(capture)
  const metrics = annotationMetrics({
    width: image.width,
    height: image.height,
  })
  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext("2d")
  context.drawImage(image, 0, 0)
  for (const label of labels) {
    const layout = labelSpriteLayout(label.at, metrics)
    const sprite = await loadImage(
      await labelSpritePNG({
        text: label.text,
        color: label.color,
        fontSize: metrics.fontSize,
        offset: layout.offset,
      })
    )
    context.drawImage(sprite, layout.left, layout.top)
  }
  return canvas.encode("png")
}

describe("Label sprites", () => {
  test("labels drawn from their sprites are the flattened labels", async () => {
    const labels: Extract<Annotation, { kind: "label" }>[] = [
      { kind: "label", color: "red", text: "2pt off", at: { x: 40, y: 60 } },
      {
        kind: "label",
        color: "white",
        text: "Spacing under the title is 8 pt, the spec says 12",
        at: { x: 12.37, y: 300.81 },
      },
      { kind: "label", color: "blue", text: "Too tight", at: { x: 0.5, y: 0 } },
    ]

    const flattened = await annotatedScreenshotPNG(capture, labels)

    // Within ±1 per channel everywhere: compositing a sprite and drawing the
    // text in place round premultiplied alpha differently, at most.
    const { mismatched } = await compareToSnapshot(
      await composited(labels),
      flattened,
      1
    )
    expect(mismatched).toBe(0)
  })

  test("a sprite is just tall and wide enough for its padded line", async () => {
    const sprite = await decodeRGBA(
      await labelSpritePNG({
        text: "Too tight",
        color: "red",
        fontSize: 47,
        offset: 0.25,
      })
    )
    const layout = labelSpriteLayout({ x: 0.25, y: 0 }, { fontSize: 47 })

    expect(sprite.height).toBe(
      2 * layout.padding + layout.ascent + layout.descent
    )
    // Only glyph pixels are opaque: the corners stay transparent.
    expect(sprite.pixels[3]).toBe(0)
    expect(sprite.pixels.at(-1)).toBe(0)
  })
})
