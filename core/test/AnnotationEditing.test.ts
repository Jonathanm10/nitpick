// Ports Tests/NitpickCoreTests/AnnotationEditingTests.swift. The Swift suite
// edits through Finding's forwarding methods; Finding arrives with issue 03,
// so these cases drive the AnnotationHistory those methods forward to.
import { describe, expect, test } from "vitest"
import {
  AnnotationHistory,
  annotationColors,
  defaultAnnotationColor,
  translated,
  type Annotation,
} from "../src/index.ts"

const pen: Annotation = {
  kind: "pen",
  color: "red",
  points: [
    { x: 10, y: 10 },
    { x: 40, y: 60 },
  ],
}
const arrow: Annotation = {
  kind: "arrow",
  color: "blue",
  from: { x: 100, y: 100 },
  to: { x: 200, y: 150 },
}
const rectangle: Annotation = {
  kind: "rectangle",
  color: "green",
  rect: { x: 20, y: 30, width: 120, height: 80 },
}
const label: Annotation = {
  kind: "label",
  color: "black",
  text: "2pt off",
  at: { x: 50, y: 200 },
}

describe("Annotation editing", () => {
  test("a new Finding carries no Annotations and nothing to undo", () => {
    const history = new AnnotationHistory()
    expect(history.annotations).toEqual([])
    expect(history.canUndo).toBe(false)
    expect(history.canRedo).toBe(false)
  })

  test("all four tools add, in order, with their palette colors", () => {
    const history = new AnnotationHistory()
      .add(pen)
      .add(arrow)
      .add(rectangle)
      .add(label)
    expect(history.annotations).toEqual([pen, arrow, rectangle, label])
    expect(history.annotations[0]?.color).toBe(defaultAnnotationColor)
    expect(history.annotations[1]?.color).toBe("blue")
  })

  test("the palette is small, fixed, and red-first", () => {
    expect(defaultAnnotationColor).toBe("red")
    expect(annotationColors[0]).toBe("red")
    expect(annotationColors).toHaveLength(6)
  })

  test("an edit replaces in place; undo restores the previous shape", () => {
    let history = new AnnotationHistory().add(pen).add(label)

    const moved: Annotation = { ...label, at: { x: 80, y: 220 } }
    history = history.replaceAnnotation(1, moved)
    expect(history.annotations).toEqual([pen, moved])

    history = history.undo()
    expect(history.annotations).toEqual([pen, label])
    expect(history.canRedo).toBe(true)
  })

  test("undo walks back each step; redo replays; a fresh edit clears redo", () => {
    let history = new AnnotationHistory().add(pen).add(arrow)

    history = history.undo()
    expect(history.annotations).toEqual([pen])
    history = history.undo()
    expect(history.annotations).toEqual([])
    expect(history.canUndo).toBe(false)

    history = history.redo()
    expect(history.annotations).toEqual([pen])

    history = history.add(rectangle)
    expect(history.annotations).toEqual([pen, rectangle])
    expect(history.canRedo).toBe(false) // the replayed future is gone
  })

  test("undo and redo with nothing to do are no-ops, not crashes", () => {
    let history = new AnnotationHistory().undo().redo()
    expect(history.annotations).toEqual([])

    history = history.add(pen).redo()
    expect(history.annotations).toEqual([pen])
  })

  test("removing an Annotation is undoable", () => {
    let history = new AnnotationHistory().add(pen).add(arrow)

    history = history.removeAnnotation(0)
    expect(history.annotations).toEqual([arrow])

    history = history.undo()
    expect(history.annotations).toEqual([pen, arrow])
  })

  test("successive translated replaces undo one per step — the arrow-key nudge contract", () => {
    let history = new AnnotationHistory().add(rectangle)

    // Three presses of the same arrow: three replaces, no coalescing.
    const step = { dx: 3, dy: 0 }
    const once = translated(rectangle, step)
    const twice = translated(once, step)
    const thrice = translated(twice, step)
    history = history
      .replaceAnnotation(0, once)
      .replaceAnnotation(0, twice)
      .replaceAnnotation(0, thrice)
    expect(history.annotations).toEqual([thrice])

    // Each ⌘Z steps back exactly one nudge, never the whole run.
    history = history.undo()
    expect(history.annotations).toEqual([twice])
    history = history.undo()
    expect(history.annotations).toEqual([once])
    history = history.undo()
    expect(history.annotations).toEqual([rectangle])
    expect(history.canUndo).toBe(true) // one step left: the original add
  })

  test("edit history never affects Finding equality — only observable state does", () => {
    const edited = new AnnotationHistory().add(pen).undo()

    expect(edited).toEqual(new AnnotationHistory())

    expect(edited.redo()).toEqual(new AnnotationHistory().add(pen))
  })

  // Not in the Swift suite: Swift's value types make every edit a copy,
  // and React state needs the same guarantee from the port.
  test("an edit returns a new history and leaves the old one as it was", () => {
    const before = new AnnotationHistory().add(pen)

    const after = before.add(arrow)

    expect(before.annotations).toEqual([pen])
    expect(before.canRedo).toBe(false)
    expect(after.annotations).toEqual([pen, arrow])
  })

  // Not in the Swift suite, where an out-of-range index traps.
  test("an edit at an index that holds no Annotation throws", () => {
    const history = new AnnotationHistory().add(pen)

    expect(() => history.replaceAnnotation(1, arrow)).toThrow(RangeError)
    expect(() => history.replaceAnnotation(-1, arrow)).toThrow(RangeError)
    expect(() => history.removeAnnotation(1)).toThrow(RangeError)
  })
})
