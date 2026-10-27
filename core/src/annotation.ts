// Ported from Sources/NitpickCore/Annotation.swift.

/**
 * The small fixed palette for Annotations. Red is the default; the rest keep
 * marks visible on any screenshot.
 */
export const annotationColors = [
  "red",
  "yellow",
  "green",
  "blue",
  "black",
  "white",
] as const

export type AnnotationColor = (typeof annotationColors)[number]

export const defaultAnnotationColor: AnnotationColor = "red"

/**
 * sRGB components from 0 to 1, pinned exactly so flattened output stays
 * snapshot-stable. One source of truth for the flattening renderer and the
 * browser's palette and preview, so previews match filed pixels.
 */
export const annotationColorComponents: Readonly<
  Record<
    AnnotationColor,
    { readonly red: number; readonly green: number; readonly blue: number }
  >
> = {
  red: { red: 1, green: 0.23, blue: 0.19 },
  yellow: { red: 1, green: 0.8, blue: 0 },
  green: { red: 0.2, green: 0.78, blue: 0.35 },
  blue: { red: 0, green: 0.48, blue: 1 },
  black: { red: 0, green: 0, blue: 0 },
  white: { red: 1, green: 1, blue: 1 },
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Vector {
  readonly dx: number
  readonly dy: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

/** May have a negative width or height, as a drag up or left draws it. */
export interface Rect extends Point, Size {}

/** The same rectangle with a non-negative width and height. */
export function standardized({ x, y, width, height }: Rect): Rect {
  return {
    x: Math.min(x, x + width),
    y: Math.min(y, y + height),
    width: Math.abs(width),
    height: Math.abs(height),
  }
}

/**
 * A markup element laid over a Finding's screenshot: pen stroke, arrow,
 * rectangle, or text label. Coordinates live in the screenshot's native pixel
 * space, origin top-left: Annotations are anchored to the capture, not to any
 * view that displays it.
 */
export type Annotation =
  /** A freehand polyline through the given points. */
  | {
      readonly kind: "pen"
      readonly color: AnnotationColor
      readonly points: readonly Point[]
    }
  /** A straight arrow; the head sits at `to`. */
  | {
      readonly kind: "arrow"
      readonly color: AnnotationColor
      readonly from: Point
      readonly to: Point
    }
  /** A stroked, unfilled rectangle. */
  | {
      readonly kind: "rectangle"
      readonly color: AnnotationColor
      readonly rect: Rect
    }
  /** A single line of text; `at` is the top-left corner of the rendered line. */
  | {
      readonly kind: "label"
      readonly color: AnnotationColor
      readonly text: string
      readonly at: Point
    }

/**
 * The Annotation translated rigidly by `offset`, in image pixels: every point
 * of a pen stroke moves, an arrow keeps its head at the head, a rectangle
 * keeps its size, a label keeps its text anchor. Nothing resizes or reshapes,
 * and color and text ride along untouched.
 */
export function translated(annotation: Annotation, offset: Vector): Annotation {
  const move = ({ x, y }: Point): Point => ({
    x: x + offset.dx,
    y: y + offset.dy,
  })
  switch (annotation.kind) {
    case "pen":
      return { ...annotation, points: annotation.points.map(move) }
    case "arrow":
      return {
        ...annotation,
        from: move(annotation.from),
        to: move(annotation.to),
      }
    case "rectangle":
      return {
        ...annotation,
        rect: { ...annotation.rect, ...move(annotation.rect) },
      }
    case "label":
      return { ...annotation, at: move(annotation.at) }
  }
}

type Annotations = readonly Annotation[]

/**
 * Annotations in stacking order with their linear undo and redo history: the
 * editing model behind a Finding's screenshot and a Feedback's window image.
 *
 * A value, like the Swift struct: every edit returns a new history and leaves
 * this one as it was. The stacks are private, so structural equality, such as
 * Vitest's `toEqual`, covers the Annotations only, never the edit history.
 */
export class AnnotationHistory {
  readonly annotations: Annotations
  #undoStack: readonly Annotations[] = []
  #redoStack: readonly Annotations[] = []

  /** `annotations` restores saved state, which carries no history. */
  constructor(annotations: Annotations = []) {
    this.annotations = annotations
  }

  static #with(
    annotations: Annotations,
    undoStack: readonly Annotations[],
    redoStack: readonly Annotations[]
  ): AnnotationHistory {
    const history = new AnnotationHistory(annotations)
    history.#undoStack = undoStack
    history.#redoStack = redoStack
    return history
  }

  /**
   * Adds an Annotation on top of the existing ones. Undoable; like every edit,
   * it discards any redoable future.
   */
  add(annotation: Annotation): AnnotationHistory {
    return this.#edit([...this.annotations, annotation])
  }

  /** Replaces the Annotation at `index`: moving a label, nudging a stroke. Undoable. */
  replaceAnnotation(index: number, annotation: Annotation): AnnotationHistory {
    this.#checkIndex(index)
    return this.#edit(this.annotations.with(index, annotation))
  }

  /** Removes the Annotation at `index`. Undoable. */
  removeAnnotation(index: number): AnnotationHistory {
    this.#checkIndex(index)
    return this.#edit(this.annotations.toSpliced(index, 1))
  }

  get canUndo(): boolean {
    return this.#undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.#redoStack.length > 0
  }

  /**
   * Steps back one Annotation edit. With nothing to undo it returns this
   * history unchanged, so a stray ⌘Z does nothing.
   */
  undo(): AnnotationHistory {
    const previous = this.#undoStack.at(-1)
    if (!previous) return this
    return AnnotationHistory.#with(previous, this.#undoStack.slice(0, -1), [
      ...this.#redoStack,
      this.annotations,
    ])
  }

  /** Replays the most recently undone edit; with none, returns this history. */
  redo(): AnnotationHistory {
    const next = this.#redoStack.at(-1)
    if (!next) return this
    return AnnotationHistory.#with(
      next,
      [...this.#undoStack, this.annotations],
      this.#redoStack.slice(0, -1)
    )
  }

  // Every edit snapshots the current state onto the undo stack and
  // invalidates the redo stack: the standard linear-history contract.
  #edit(annotations: Annotations): AnnotationHistory {
    return AnnotationHistory.#with(
      annotations,
      [...this.#undoStack, this.annotations],
      []
    )
  }

  // Swift traps on an out-of-range index; a silent no-op here would hide the
  // caller's bug.
  #checkIndex(index: number) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.annotations.length
    ) {
      throw new RangeError(`No Annotation at index ${index}`)
    }
  }
}
