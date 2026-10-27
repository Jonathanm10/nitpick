// Ports the geometry case of Tests/NitpickCoreTests/AnnotationFlatteningTests.swift.
// The flattening cases need a rasterizer, so they live in
// server/test/AnnotationFlattening.test.ts.
import { describe, expect, test } from "vitest"
import { annotationMetrics } from "../src/index.ts"

describe("Annotation flattening", () => {
  test("stroke width and font size scale with the capture's resolution", () => {
    const phone = annotationMetrics({ width: 1179, height: 2556 })
    const small = annotationMetrics({ width: 480, height: 960 })
    expect(phone.strokeWidth).toBeGreaterThan(small.strokeWidth)
    expect(phone.fontSize).toBeGreaterThan(small.fontSize)
    // Tiny images still get visible marks.
    const tiny = annotationMetrics({ width: 32, height: 32 })
    expect(tiny.strokeWidth).toBeGreaterThanOrEqual(3)
    expect(tiny.fontSize).toBeGreaterThanOrEqual(13)
  })

  // Not in the Swift suite, which reads its metrics off rendered pixels: the
  // exact values, so a browser preview and the server agree on them.
  test("the four-tools capture and a phone capture get the Swift app's metrics", () => {
    expect(annotationMetrics({ width: 480, height: 960 })).toEqual({
      strokeWidth: 6,
      fontSize: 17,
      arrowHeadLength: 24,
      arrowHeadWidth: 18,
      hitTolerance: 12,
    })
    expect(annotationMetrics({ width: 1206, height: 2622 })).toEqual({
      strokeWidth: 16,
      fontSize: 47,
      arrowHeadLength: 64,
      arrowHeadWidth: 48,
      hitTolerance: 32,
    })
  })
})
