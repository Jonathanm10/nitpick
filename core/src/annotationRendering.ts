// Ported from Sources/NitpickCore/AnnotationRendering.swift. The geometry and
// the draw calls live here; the rasterizer does not. The browser draws its
// preview into a <canvas>, and the server flattens with a Node canvas, through
// the same drawAnnotations.
import {
  annotationColorComponents,
  standardized,
  type Annotation,
  type AnnotationColor,
  type Point,
  type Size,
} from "./annotation.ts"

/**
 * Sizing for rendered Annotations, derived from the capture's native pixel
 * size so marks stay visible at any device resolution. The browser's preview
 * uses the same metrics, scaled to the view: what the Reviewer draws is what
 * the developer downloads.
 */
export interface AnnotationMetrics {
  readonly strokeWidth: number
  readonly fontSize: number
  readonly arrowHeadLength: number
  readonly arrowHeadWidth: number
  /**
   * How far, in image pixels, a click may land from a mark's path and still
   * hit it. Scaled to the stroke width so thin marks are not precision
   * targets at any capture resolution.
   */
  readonly hitTolerance: number
}

export function annotationMetrics(imageSize: Size): AnnotationMetrics {
  const maxDimension = Math.max(imageSize.width, imageSize.height)
  const strokeWidth = Math.max(3, Math.round(maxDimension * 0.006))
  return {
    strokeWidth,
    fontSize: Math.max(13, Math.round(maxDimension * 0.018)),
    arrowHeadLength: strokeWidth * 4,
    arrowHeadWidth: strokeWidth * 3,
    hitTolerance: strokeWidth * 2,
  }
}

/**
 * The label typeface as a CSS font: Helvetica Bold, the face the Swift app
 * draws with. The Device Host is a Mac, so the server always has it; Arial,
 * metric-compatible, stands in where a browser has no Helvetica.
 */
export function labelFont(metrics: AnnotationMetrics): string {
  return `bold ${metrics.fontSize}px Helvetica, Arial, sans-serif`
}

// Helvetica Bold's ascent and descent per em, as CoreText reports them
// (1577 and 471 of 2048 units). A canvas's measureText reports other font
// boxes, so the label's line box comes from these.
const labelAscent = 1577 / 2048
const labelDescent = 471 / 2048

/** The vertical extent of a label's line, in image pixels. */
export function labelLineMetrics(metrics: AnnotationMetrics): {
  readonly ascent: number
  readonly descent: number
} {
  return {
    ascent: metrics.fontSize * labelAscent,
    descent: metrics.fontSize * labelDescent,
  }
}

/** The palette color as a CSS hex color, each sRGB component rounded to 8 bits. */
export function annotationCSSColor(color: AnnotationColor): string {
  const { red, green, blue } = annotationColorComponents[color]
  const hex = (component: number) =>
    Math.round(component * 255)
      .toString(16)
      .padStart(2, "0")
  return `#${hex(red)}${hex(green)}${hex(blue)}`
}

/**
 * What hit-testing needs to measure a label: a canvas 2D context, from the
 * browser's <canvas> or the server's Node canvas.
 */
export interface TextMeasurer {
  font: string
  measureText(text: string): { readonly width: number }
}

/**
 * The part of a canvas 2D context the Annotations draw with. Declared here,
 * not taken from the DOM's types, so `core/` stays free of browser and Node
 * types; a browser CanvasRenderingContext2D and the server's canvas both fit.
 */
export interface AnnotationCanvas extends TextMeasurer {
  strokeStyle: string | object
  fillStyle: string | object
  lineWidth: number
  lineCap: string
  lineJoin: string
  textAlign: string
  textBaseline: string
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  stroke(): void
  fill(): void
  strokeRect(x: number, y: number, width: number, height: number): void
  fillText(text: string, x: number, y: number): void
}

/**
 * Draws `annotations` in stacking order onto `canvas`, in image pixel
 * coordinates with the origin top-left. The server draws onto the capture at
 * native resolution; a preview scales the canvas first.
 */
export function drawAnnotations(
  canvas: AnnotationCanvas,
  annotations: readonly Annotation[],
  metrics: AnnotationMetrics
): void {
  for (const annotation of annotations)
    drawAnnotation(canvas, annotation, metrics)
}

export function drawAnnotation(
  canvas: AnnotationCanvas,
  annotation: Annotation,
  metrics: AnnotationMetrics
): void {
  canvas.save()
  const color = annotationCSSColor(annotation.color)
  canvas.strokeStyle = color
  canvas.fillStyle = color
  canvas.lineWidth = metrics.strokeWidth
  canvas.lineCap = "round"
  canvas.lineJoin = "round"

  switch (annotation.kind) {
    case "pen": {
      const [first, ...rest] = annotation.points
      if (!first) break
      // A single point still leaves a visible dot: the round cap of a
      // zero-length stroke.
      canvas.beginPath()
      canvas.moveTo(first.x, first.y)
      for (const point of rest) canvas.lineTo(point.x, point.y)
      if (rest.length === 0) canvas.lineTo(first.x, first.y)
      canvas.stroke()
      break
    }

    case "arrow": {
      const head = arrowHead(annotation.from, annotation.to, metrics)
      if (!head) break
      // The shaft stops where the head begins, so the tip stays sharp.
      canvas.beginPath()
      canvas.moveTo(annotation.from.x, annotation.from.y)
      canvas.lineTo(head.base.x, head.base.y)
      canvas.stroke()

      canvas.beginPath()
      canvas.moveTo(annotation.to.x, annotation.to.y)
      canvas.lineTo(head.left.x, head.left.y)
      canvas.lineTo(head.right.x, head.right.y)
      canvas.closePath()
      canvas.fill()
      break
    }

    case "rectangle": {
      const { x, y, width, height } = standardized(annotation.rect)
      canvas.strokeRect(x, y, width, height)
      break
    }

    case "label": {
      if (annotation.text === "") break
      canvas.font = labelFont(metrics)
      canvas.textAlign = "left"
      canvas.textBaseline = "alphabetic"
      // The baseline sits one ascent below the anchor. CoreGraphics puts it
      // on the pixel row at or below that, and canvases round it to the
      // nearer row; snapping first makes them all agree.
      const baseline = annotation.at.y + labelLineMetrics(metrics).ascent
      canvas.fillText(annotation.text, annotation.at.x, Math.ceil(baseline))
      break
    }
  }
  canvas.restore()
}

/**
 * Where an arrow's head begins on the shaft and its two back corners, or
 * undefined for a zero-length arrow, which draws nothing.
 */
function arrowHead(
  from: Point,
  to: Point,
  metrics: AnnotationMetrics
): { base: Point; left: Point; right: Point } | undefined {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length === 0) return undefined
  const direction = { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
  const base = {
    x: to.x - direction.x * metrics.arrowHeadLength,
    y: to.y - direction.y * metrics.arrowHeadLength,
  }
  const halfWidth = metrics.arrowHeadWidth / 2
  const normal = { x: -direction.y, y: direction.x }
  return {
    base,
    left: {
      x: base.x + normal.x * halfWidth,
      y: base.y + normal.y * halfWidth,
    },
    right: {
      x: base.x - normal.x * halfWidth,
      y: base.y - normal.y * halfWidth,
    },
  }
}
