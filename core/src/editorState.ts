// Ported from Sources/NitpickCore/EditorState.swift. EditorEscape and
// allowsDiscard stay with the Review Session port (issue 03): they read the
// Tray's pristine rule and the shell's activity.
import type { Annotation, Vector } from "./annotation.ts"

/** What the Editor reads of a Review Session: the IDs of its Tray items. */
export interface EditorSession {
  readonly tray: readonly { readonly id: string }[]
}

let lastGeneration = 0

/**
 * The Editor's target and the state that belongs to it. `target` and
 * `generation` never change in place: pointing the Editor elsewhere builds a
 * fresh value, so every field, one added later included, starts over on every
 * capture, Tray selection, and close.
 */
export class EditorState {
  /** Undefined hides the Editor. */
  readonly target: string | undefined
  /**
   * New with every value: it resets the annotation surface's in-flight draft
   * even when two targets share a pixel size, and it is the stamp an
   * Annotation selection carries.
   */
  readonly generation: number
  /**
   * A placed, uncommitted text label pins the Editor: retargeting first would
   * land its commit on the wrong Finding.
   */
  readonly hasPendingLabelDraft: boolean = false
  readonly designSnapshotError: string | undefined

  /** Never refused, unlike `selecting`: the capture gate already refuses a pinned Editor. */
  constructor(target?: string) {
    this.target = target
    this.generation = ++lastGeneration
  }

  /**
   * A fresh Editor on `item`, or undefined when the selection is refused: the
   * item is already the target, a label draft pins the Editor, or the item
   * isn't in the open session's Tray.
   */
  selecting(
    item: string,
    session: EditorSession | undefined
  ): EditorState | undefined {
    if (
      this.target === item ||
      this.hasPendingLabelDraft ||
      !session?.tray.some((trayItem) => trayItem.id === item)
    ) {
      return undefined
    }
    return new EditorState(item)
  }

  /** The same Editor, target and generation kept, with the label draft set. */
  withPendingLabelDraft(pending: boolean): EditorState {
    return copied(this, { hasPendingLabelDraft: pending })
  }

  /** The same Editor, target and generation kept, with the Design Snapshot error set. */
  withDesignSnapshotError(error: string | undefined): EditorState {
    return copied(this, { designSnapshotError: error })
  }
}

function copied(
  editor: EditorState,
  changes: Partial<
    Pick<EditorState, "hasPendingLabelDraft" | "designSnapshotError">
  >
): EditorState {
  // Skips the constructor, which would mint a new generation.
  return Object.assign(Object.create(EditorState.prototype), editor, changes)
}

/**
 * Workspace chrome, never persisted, never flattened into any PNG. Its
 * `generation` ties it to the Editor target it was made on, so a retarget can
 * tell the selection it left behind.
 */
export class AnnotationSelection<Overlay> {
  readonly generation: number
  readonly index: number
  readonly drag: AnnotationDrag<Overlay> | undefined

  constructor(
    index: number,
    editor: Pick<EditorState, "generation">,
    drag?: AnnotationDrag<Overlay>
  ) {
    this.generation = editor.generation
    this.index = index
    this.drag = drag
  }

  belongs(editor: EditorState): boolean {
    return this.generation === editor.generation
  }

  withDrag(
    drag: AnnotationDrag<Overlay> | undefined
  ): AnnotationSelection<Overlay> {
    return new AnnotationSelection(this.index, this, drag)
  }

  /**
   * The selection after the Annotation at `removed` is deleted: on the same
   * shape, whose index shifts down when an earlier one goes, or undefined
   * when the selected shape itself goes. Any drag in flight is dropped.
   */
  removingAnnotation(
    removed: number
  ): AnnotationSelection<Overlay> | undefined {
    if (this.index === removed) return undefined
    return new AnnotationSelection(
      this.index > removed ? this.index - 1 : this.index,
      this
    )
  }
}

/**
 * A rigid move of the selected Annotation, in flight from the first cursor
 * movement on the shape until release. Generic over the overlay, the image of
 * the shape the view shifts while the drag lasts, so the core stays free of
 * any drawing surface.
 */
export interface AnnotationDrag<Overlay> {
  /** The Annotation as the drag found it: release translates this, and commits only if it is still in place. */
  readonly annotation: Annotation
  readonly overlayImage: Overlay
  /** Whole image pixels: the single source for the live preview and the committed move alike. */
  readonly offset: Vector
}

export function annotationDrag<Overlay>(
  annotation: Annotation,
  overlayImage: Overlay
): AnnotationDrag<Overlay> {
  return { annotation, overlayImage, offset: { dx: 0, dy: 0 } }
}
