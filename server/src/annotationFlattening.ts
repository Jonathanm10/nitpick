// Flattens a Finding's Annotations into the PNG that gets filed, ported from
// Finding.annotatedScreenshotPNG in Sources/NitpickCore/AnnotationRendering.swift.
// The geometry and draw calls come from core/, which the browser's preview
// shares; the rasterizer and the PNG encoder are Skia, through @napi-rs/canvas.
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas"
import {
  annotationCSSColor,
  annotationMetrics,
  drawAnnotations,
  labelFont,
  labelSpriteLayout,
  type Annotation,
  type AnnotationColor,
} from "@nitpick/core"

/** The Finding's screenshot bytes don't decode as an image. */
export class UnreadableScreenshot extends Error {
  constructor() {
    super(
      "The capture could not be read as an image, so Annotations cannot be flattened."
    )
    this.name = "UnreadableScreenshot"
  }
}

/**
 * The annotated screenshot: the clean capture with every Annotation flattened
 * in, at native resolution. With no Annotations the annotated variant is the
 * original, and the exact bytes pass through.
 */
export async function annotatedScreenshotPNG(
  png: Uint8Array,
  annotations: readonly Annotation[]
): Promise<Uint8Array> {
  if (annotations.length === 0) return png

  let capture: Image
  try {
    capture = await loadImage(png)
  } catch {
    throw new UnreadableScreenshot()
  }
  const size = { width: capture.width, height: capture.height }
  const canvas = createCanvas(size.width, size.height)
  const context = canvas.getContext("2d")
  context.drawImage(capture, 0, 0)
  drawAnnotations(context, annotations, annotationMetrics(size))
  return canvas.encode("png")
}

/**
 * A label's glyphs alone on transparency, for the browser's preview: drawn
 * by the rasterizer and fonts that flatten, at the subpixel `offset` its x
 * has, so placed at core's labelSpriteLayout it is the flattened label.
 */
export async function labelSpritePNG(label: {
  readonly text: string
  readonly color: AnnotationColor
  readonly fontSize: number
  readonly offset: number
}): Promise<Uint8Array> {
  const metrics = { fontSize: label.fontSize }
  const { padding, ascent, descent } = labelSpriteLayout(
    { x: label.offset, y: 0 },
    metrics
  )
  const measurer = createCanvas(1, 1).getContext("2d")
  measurer.font = labelFont(metrics)
  const width = measurer.measureText(label.text).width
  const canvas = createCanvas(
    Math.ceil(2 * padding + label.offset + width),
    2 * padding + ascent + descent
  )
  const context = canvas.getContext("2d")
  context.fillStyle = annotationCSSColor(label.color)
  context.font = labelFont(metrics)
  context.textAlign = "left"
  context.textBaseline = "alphabetic"
  context.fillText(label.text, padding + label.offset, padding + ascent)
  return canvas.encode("png")
}
