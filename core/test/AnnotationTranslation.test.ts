// Ports Tests/NitpickCoreTests/AnnotationTranslationTests.swift. Expected
// positions are independent literals, never recomputed the way the code does.
import { describe, expect, test } from "vitest"
import { translated, type Annotation } from "../src/index.ts"

const offset = { dx: 40, dy: -25 }

describe("Annotation rigid translation", () => {
  test("a pen stroke moves every point", () => {
    const moved = translated(
      {
        kind: "pen",
        color: "blue",
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 80 },
          { x: 55, y: 25 },
        ],
      },
      offset
    )
    expect(moved).toEqual({
      kind: "pen",
      color: "blue",
      points: [
        { x: 50, y: -5 },
        { x: 70, y: 55 },
        { x: 95, y: 0 },
      ],
    })
  })

  test("an arrow keeps its head at the head", () => {
    const moved = translated(
      {
        kind: "arrow",
        color: "red",
        from: { x: 100, y: 200 },
        to: { x: 160, y: 120 },
      },
      offset
    )
    expect(moved).toEqual({
      kind: "arrow",
      color: "red",
      from: { x: 140, y: 175 },
      to: { x: 200, y: 95 },
    })
  })

  test("a rectangle keeps its size", () => {
    const moved = translated(
      {
        kind: "rectangle",
        color: "red",
        rect: { x: 60, y: 500, width: 240, height: 160 },
      },
      offset
    )
    expect(moved).toEqual({
      kind: "rectangle",
      color: "red",
      rect: { x: 100, y: 475, width: 240, height: 160 },
    })
  })

  test("a label keeps its text at the moved anchor", () => {
    const moved = translated(
      {
        kind: "label",
        color: "black",
        text: "2pt off",
        at: { x: 100, y: 700 },
      },
      offset
    )
    expect(moved).toEqual({
      kind: "label",
      color: "black",
      text: "2pt off",
      at: { x: 140, y: 675 },
    })
  })

  test("a zero offset is the identity", () => {
    const annotation: Annotation = {
      kind: "pen",
      color: "green",
      points: [{ x: 10, y: 20 }],
    }
    expect(translated(annotation, { dx: 0, dy: 0 })).toEqual(annotation)
  })
})
