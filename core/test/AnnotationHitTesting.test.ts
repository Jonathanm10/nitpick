// Ports Tests/NitpickCoreTests/AnnotationHitTestingTests.swift. An image-pixel
// point maps to the index of the topmost Annotation it hits, using the same
// geometry the renderer draws with. The Swift suite hits through Finding,
// which arrives with issue 03; these cases hit through the AnnotationHistory
// Finding forwards to.
import { describe, expect, test } from "vitest"
import {
  AnnotationHistory,
  annotationIndexAt,
  annotationMetrics,
  boundingRect,
  labelFont,
  type Annotation,
  type Point,
  type TextMeasurer,
} from "../src/index.ts"

// A 1000×2000 capture: strokeWidth 12, so hit geometry is roomy enough to
// probe on either side of the tolerance line.
const metrics = annotationMetrics({ width: 1000, height: 2000 })
const tolerance = metrics.hitTolerance

// Stands in for the canvas the browser and the server measure with: every
// glyph advances 0.6 em, and only in the label font.
const measurer: TextMeasurer = {
  font: "",
  measureText(text) {
    expect(this.font).toBe(labelFont(metrics))
    return { width: text.length * metrics.fontSize * 0.6 }
  },
}

function indexAt(annotations: Annotation[], point: Point) {
  const history = annotations.reduce(
    (history, annotation) => history.add(annotation),
    new AnnotationHistory()
  )
  return annotationIndexAt(history.annotations, point, metrics, measurer)
}

function labelBounds(annotation: Annotation) {
  const bounds = boundingRect(annotation, metrics, measurer)
  if (!bounds) throw new Error("the label has no bounds")
  return bounds
}

describe("Annotation hit-testing", () => {
  test("a pen stroke hits within tolerance of its path and misses outside it", () => {
    const pen: Annotation[] = [
      {
        kind: "pen",
        color: "red",
        points: [
          { x: 100, y: 100 },
          { x: 300, y: 100 },
        ],
      },
    ]
    expect(indexAt(pen, { x: 200, y: 100 })).toBe(0)
    expect(indexAt(pen, { x: 200, y: 100 + tolerance })).toBe(0)
    expect(indexAt(pen, { x: 200, y: 100 + tolerance + 1 })).toBeUndefined()
  })

  test("a single-point pen dot is a hit target, not a precision trap", () => {
    const dot: Annotation[] = [
      { kind: "pen", color: "red", points: [{ x: 400, y: 400 }] },
    ]
    expect(indexAt(dot, { x: 400, y: 400 })).toBe(0)
    expect(indexAt(dot, { x: 400 + tolerance, y: 400 })).toBe(0)
    expect(indexAt(dot, { x: 400 + tolerance + 1, y: 400 })).toBeUndefined()
  })

  test("an arrow hits along its shaft and at its head, misses beyond tolerance", () => {
    const arrow: Annotation[] = [
      {
        kind: "arrow",
        color: "red",
        from: { x: 100, y: 500 },
        to: { x: 500, y: 500 },
      },
    ]
    expect(indexAt(arrow, { x: 300, y: 500 })).toBe(0) // shaft
    expect(indexAt(arrow, { x: 500, y: 500 })).toBe(0) // head tip
    expect(indexAt(arrow, { x: 300, y: 500 + tolerance + 1 })).toBeUndefined()
    expect(indexAt(arrow, { x: 500 + tolerance + 1, y: 500 })).toBeUndefined()
  })

  test("a rectangle hits on its stroke, never its interior", () => {
    const rectangle: Annotation[] = [
      {
        kind: "rectangle",
        color: "red",
        rect: { x: 200, y: 200, width: 400, height: 300 },
      },
    ]
    expect(indexAt(rectangle, { x: 200, y: 350 })).toBe(0) // left edge
    expect(indexAt(rectangle, { x: 200, y: 200 })).toBe(0) // corner
    expect(indexAt(rectangle, { x: 200 + tolerance, y: 350 })).toBe(0) // inside, near the stroke
    expect(indexAt(rectangle, { x: 400, y: 350 })).toBeUndefined() // interior center
    expect(
      indexAt(rectangle, { x: 200 - tolerance - 1, y: 350 })
    ).toBeUndefined()
  })

  test("a label hits on its rendered text bounds", () => {
    const label: Annotation = {
      kind: "label",
      color: "black",
      text: "2pt off",
      at: { x: 600, y: 1000 },
    }
    const bounds = labelBounds(label)
    expect(bounds.x).toBe(600) // the anchor is the rendered line's top-left
    expect(bounds.y).toBe(1000)
    expect(bounds.width).toBeGreaterThan(metrics.fontSize) // several glyphs wide
    expect(bounds.height).toBeGreaterThanOrEqual(metrics.fontSize / 2)
    const midX = bounds.x + bounds.width / 2
    const midY = bounds.y + bounds.height / 2
    expect(indexAt([label], { x: midX, y: midY })).toBe(0)
    expect(
      indexAt([label], { x: bounds.x + bounds.width + 1, y: midY })
    ).toBeUndefined()
    expect(indexAt([label], { x: midX, y: bounds.y - 1 })).toBeUndefined()
  })

  test("an empty label renders nothing and hits nothing", () => {
    const label: Annotation = {
      kind: "label",
      color: "red",
      text: "",
      at: { x: 600, y: 1000 },
    }
    expect(indexAt([label], { x: 600, y: 1000 })).toBeUndefined()
  })

  test("a frame never shields a label inside it — interior misses, label hits", () => {
    const frame: Annotation = {
      kind: "rectangle",
      color: "green",
      rect: { x: 100, y: 800, width: 800, height: 600 },
    }
    const label: Annotation = {
      kind: "label",
      color: "black",
      text: "Misaligned",
      at: { x: 400, y: 1050 },
    }
    const bounds = labelBounds(label)
    const onLabel = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    }
    expect(indexAt([frame, label], onLabel)).toBe(1)
    expect(indexAt([frame, label], { x: 100, y: 1100 })).toBe(0) // frame stroke
    expect(indexAt([frame, label], { x: 250, y: 900 })).toBeUndefined() // empty interior
  })

  test("overlapping shapes resolve topmost-first in stacking order", () => {
    const below: Annotation = {
      kind: "pen",
      color: "red",
      points: [
        { x: 100, y: 1500 },
        { x: 500, y: 1500 },
      ],
    }
    const above: Annotation = {
      kind: "pen",
      color: "blue",
      points: [
        { x: 300, y: 1300 },
        { x: 300, y: 1700 },
      ],
    }
    // The crossing point hits both; the later — topmost — wins.
    expect(indexAt([below, above], { x: 300, y: 1500 })).toBe(1)
    // Off the crossing, each is reachable on its own.
    expect(indexAt([below, above], { x: 150, y: 1500 })).toBe(0)
    expect(indexAt([below, above], { x: 300, y: 1350 })).toBe(1)
  })

  test("a Finding with no Annotations hits nothing", () => {
    expect(indexAt([], { x: 500, y: 500 })).toBeUndefined()
  })

  test("bounding rects cover the rendered mark, for the shell's selection indicator", () => {
    const contains = (rect: ReturnType<typeof boundingRect>, { x, y }: Point) =>
      rect !== undefined &&
      x >= rect.x &&
      x <= rect.x + rect.width &&
      y >= rect.y &&
      y <= rect.y + rect.height

    const penBounds = boundingRect(
      {
        kind: "pen",
        color: "red",
        points: [
          { x: 100, y: 100 },
          { x: 300, y: 160 },
        ],
      },
      metrics,
      measurer
    )
    expect(contains(penBounds, { x: 100, y: 100 })).toBe(true)
    expect(contains(penBounds, { x: 300, y: 160 })).toBe(true)

    const arrowBounds = boundingRect(
      {
        kind: "arrow",
        color: "red",
        from: { x: 100, y: 500 },
        to: { x: 500, y: 500 },
      },
      metrics,
      measurer
    )
    // The head fans arrowHeadWidth wide around the shaft — the indicator must cover it.
    expect(
      contains(arrowBounds, { x: 500, y: 500 + metrics.arrowHeadWidth / 2 - 1 })
    ).toBe(true)

    expect(
      boundingRect({ kind: "pen", color: "red", points: [] }, metrics, measurer)
    ).toBeUndefined()
  })
})
