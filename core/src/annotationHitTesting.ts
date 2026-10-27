// Ported from Sources/NitpickCore/AnnotationHitTesting.swift.
import {
  standardized,
  type Annotation,
  type Point,
  type Rect,
} from "./annotation.ts"
import {
  labelFont,
  labelLineMetrics,
  type AnnotationMetrics,
  type TextMeasurer,
} from "./annotationRendering.ts"

/**
 * The index of the topmost Annotation under `point`, in image pixels, or
 * undefined when the point hits nothing. Overlaps resolve topmost-first in
 * stacking order, so a click on stacked marks selects what the Reviewer sees
 * on top.
 */
export function annotationIndexAt(
  annotations: readonly Annotation[],
  point: Point,
  metrics: AnnotationMetrics,
  measurer: TextMeasurer
): number | undefined {
  const index = annotations.findLastIndex((annotation) =>
    hitTest(annotation, point, metrics, measurer)
  )
  return index === -1 ? undefined : index
}

/**
 * Whether `point`, in image pixels, hits the Annotation as drawn with
 * `metrics`. Rectangles hit on their stroke only, so a frame never shields the
 * marks it encloses; pen strokes and arrows hit within `hitTolerance` of their
 * path; labels hit on their rendered text bounds.
 */
export function hitTest(
  annotation: Annotation,
  point: Point,
  metrics: AnnotationMetrics,
  measurer: TextMeasurer
): boolean {
  const near = (start: Point, end: Point) =>
    distanceToSegment(point, start, end) <= metrics.hitTolerance

  switch (annotation.kind) {
    case "pen": {
      const [first, ...rest] = annotation.points
      if (!first) return false
      // A single point draws as a dot; a degenerate segment measures the
      // distance to that point.
      if (rest.length === 0) return near(first, first)
      return rest.some((end, index) => near(annotation.points[index]!, end))
    }

    case "arrow":
      // The head fans arrowHeadWidth / 2 (1.5 × strokeWidth) around the
      // shaft's line, inside the tolerance, so one segment covers shaft and
      // head alike.
      return near(annotation.from, annotation.to)

    case "rectangle": {
      const { x, y, width, height } = standardized(annotation.rect)
      const corners = [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ]
      return corners.some((corner, index) =>
        near(corner, corners[(index + 1) % 4]!)
      )
    }

    case "label": {
      const bounds = boundingRect(annotation, metrics, measurer)
      return bounds !== undefined && contains(bounds, point)
    }
  }
}

/**
 * The rendered bounds in image pixels: what the browser's selection indicator
 * outlines. A label measures with the font it draws with, so the outline hugs
 * the visible text. Undefined for a shape that draws nothing: an empty pen
 * stroke or an empty label.
 */
export function boundingRect(
  annotation: Annotation,
  metrics: AnnotationMetrics,
  measurer: TextMeasurer
): Rect | undefined {
  switch (annotation.kind) {
    case "pen":
      if (annotation.points.length === 0) return undefined
      return outset(enclosing(annotation.points), metrics.strokeWidth / 2)

    case "arrow":
      return outset(
        enclosing([annotation.from, annotation.to]),
        Math.max(metrics.strokeWidth, metrics.arrowHeadWidth) / 2
      )

    case "rectangle":
      return outset(standardized(annotation.rect), metrics.strokeWidth / 2)

    case "label": {
      if (annotation.text === "") return undefined
      measurer.font = labelFont(metrics)
      const { ascent, descent } = labelLineMetrics(metrics)
      return {
        ...annotation.at,
        width: measurer.measureText(annotation.text).width,
        height: ascent + descent,
      }
    }
  }
}

/** The smallest rectangle that holds every point. */
function enclosing(points: readonly Point[]): Rect {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const { x, y } of points) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function outset({ x, y, width, height }: Rect, by: number): Rect {
  return {
    x: x - by,
    y: y - by,
    width: width + 2 * by,
    height: height + 2 * by,
  }
}

function contains({ x, y, width, height }: Rect, point: Point): boolean {
  return (
    point.x >= x && point.x < x + width && point.y >= y && point.y < y + height
  )
}

/**
 * The distance from `point` to the segment from `start` to `end`; to the
 * nearer endpoint when the perpendicular foot falls outside the segment.
 */
function distanceToSegment(point: Point, start: Point, end: Point): number {
  const deltaX = end.x - start.x
  const deltaY = end.y - start.y
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  if (lengthSquared === 0)
    return Math.hypot(point.x - start.x, point.y - start.y)
  const along =
    ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) /
    lengthSquared
  const clamped = Math.max(0, Math.min(1, along))
  return Math.hypot(
    point.x - (start.x + clamped * deltaX),
    point.y - (start.y + clamped * deltaY)
  )
}
