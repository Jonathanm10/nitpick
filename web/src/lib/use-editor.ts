// The Editor's state, after the Annotation half of
// Sources/Nitpick/AppModel.swift: which Finding it shows, the tool and colour,
// the Annotation selection and its drag, and each Finding's undo history.
// Every committed edit is a core call; the review saves the result.
import { useState } from "react"
import {
  AnnotationHistory,
  AnnotationSelection,
  annotationDrag,
  annotationIndexAt,
  defaultAnnotationColor,
  EditorState,
  escapeInEditor,
  escapeOnSurface,
  hitTest,
  isEditable,
  stepEditor,
  translated,
  type Annotation,
  type AnnotationColor,
  type AnnotationMetrics,
  type Point,
  type TextMeasurer,
  type TrayItem,
  type TrayStep,
  type Vector,
} from "@nitpick/core"
import type { SessionSummary } from "@nitpick/server/api"

/**
 * Which tool the next gesture uses. Select picks up a committed Annotation;
 * the rest draw.
 */
export type AnnotationTool = "select" | "pen" | "arrow" | "rectangle" | "label"

/** The shape a drag leaves behind; nothing else rides along in the page. */
type Selection = AnnotationSelection<null>

export function useEditor({
  session,
  isBusy,
  onAnnotations,
  onDiscard,
}: {
  readonly session: SessionSummary | undefined
  readonly isBusy: boolean
  /** Saves a Finding's Annotations, the same array the history holds. */
  readonly onAnnotations: (
    itemID: string,
    annotations: ReadonlyArray<Annotation>
  ) => void
  readonly onDiscard: (itemID: string) => void
}) {
  const [editor, setEditor] = useState(() => new EditorState())
  const [tool, setToolState] = useState<AnnotationTool>("pen")
  const [color, setColor] = useState<AnnotationColor>(defaultAnnotationColor)
  const [selectionState, setSelection] = useState<Selection>()
  // Kept per Finding for the page's life, as Swift's Finding held its own:
  // a row switch and back still undoes. A reload starts each one fresh.
  const [histories, setHistories] = useState(
    () => new Map<string, AnnotationHistory>()
  )

  const item = session?.tray.find((candidate) => candidate.id === editor.target)
  /** The Finding when it takes edits now: editable, and nothing running. */
  const editable =
    item !== undefined && isEditable(item) && !isBusy ? item : undefined
  const canEdit = editable !== undefined
  // A retarget leaves the old target's selection behind.
  const selection = selectionState?.belongs(editor) ? selectionState : undefined
  const annotations = item?.finding.annotations ?? []
  const selectedAnnotation =
    selection === undefined ? undefined : annotations[selection.index]

  /** The Finding's history, fresh when its Annotations came from elsewhere. */
  function historyOf(target: TrayItem): AnnotationHistory {
    const kept = histories.get(target.id)
    return kept?.annotations === target.finding.annotations
      ? kept
      : new AnnotationHistory(target.finding.annotations)
  }

  function commit(target: TrayItem, next: AnnotationHistory) {
    setHistories((current) => new Map(current).set(target.id, next))
    onAnnotations(target.id, next.annotations)
  }

  /** Opens a Tray row. Refused while a label draft pins the Editor. */
  function select(itemID: string) {
    const next = editor.selecting(itemID, session)
    if (next !== undefined) setEditor(next)
  }

  /** A fresh capture always opens: the capture gate already refused a pinned Editor. */
  function open(itemID: string) {
    setEditor(new EditorState(itemID))
  }

  function step(direction: TrayStep) {
    const next = stepEditor(editor, direction, session)
    if (next !== undefined) setEditor(next)
  }

  function canStep(direction: TrayStep): boolean {
    return stepEditor(editor, direction, session) !== undefined
  }

  /**
   * A draw tool drops the selection, so a stray key never reaches it, and
   * any move in flight is abandoned.
   */
  function setTool(next: AnnotationTool) {
    setToolState(next)
    setSelection((current) =>
      next === "select" ? current?.withDrag(undefined) : undefined
    )
  }

  function setPendingLabelDraft(pending: boolean) {
    setEditor((current) =>
      current.hasPendingLabelDraft === pending
        ? current
        : current.withPendingLabelDraft(pending)
    )
  }

  function add(annotation: Annotation) {
    if (editable === undefined) return
    commit(editable, historyOf(editable).add(annotation))
  }

  // History moves indices arbitrarily, so a stale selection must never
  // point Delete at the wrong Annotation.
  function undo() {
    if (editable === undefined) return
    setSelection(undefined)
    commit(editable, historyOf(editable).undo())
  }

  function redo() {
    if (editable === undefined) return
    setSelection(undefined)
    commit(editable, historyOf(editable).redo())
  }

  /** The topmost committed Annotation under an image-pixel point. */
  function indexAt(
    point: Point,
    metrics: AnnotationMetrics,
    measurer: TextMeasurer
  ): number | undefined {
    return annotationIndexAt(annotations, point, metrics, measurer)
  }

  /** A Select-tool click: the topmost Annotation under it, or nothing. */
  function selectAt(
    point: Point,
    metrics: AnnotationMetrics,
    measurer: TextMeasurer
  ) {
    const index = indexAt(point, metrics, measurer)
    setSelection(
      index === undefined ? undefined : new AnnotationSelection(index, editor)
    )
  }

  /**
   * One removal, one undo step. Checked against the current Annotations,
   * since a context menu holds its index while it stays open. A selection
   * elsewhere survives, shifted when an earlier shape goes.
   */
  function deleteAt(index: number) {
    if (editable === undefined || index < 0 || index >= annotations.length) {
      return
    }
    setSelection(selection?.removingAnnotation(index))
    commit(editable, historyOf(editable).removeAnnotation(index))
  }

  function deleteSelected() {
    if (selection !== undefined) deleteAt(selection.index)
  }

  /**
   * Moves the selection one stroke width, `multiplier` times: one undo step
   * per press. Ignored mid-drag, where the pointer owns the shape.
   */
  function nudge(direction: Vector, multiplier: number, strokeWidth: number) {
    if (
      editable === undefined ||
      selection === undefined ||
      selection.drag !== undefined ||
      selectedAnnotation === undefined
    ) {
      return
    }
    const distance = strokeWidth * multiplier
    commit(
      editable,
      historyOf(editable).replaceAnnotation(
        selection.index,
        translated(selectedAnnotation, {
          dx: direction.dx * distance,
          dy: direction.dy * distance,
        })
      )
    )
  }

  /** Starts a move when the press lands on the selected Annotation. */
  function beginDrag(
    point: Point,
    metrics: AnnotationMetrics,
    measurer: TextMeasurer
  ): boolean {
    if (
      !canEdit ||
      selection === undefined ||
      selectedAnnotation === undefined ||
      !hitTest(selectedAnnotation, point, metrics, measurer)
    ) {
      return false
    }
    setSelection(selection.withDrag(annotationDrag(selectedAnnotation, null)))
    return true
  }

  /**
   * Tracks the pointer. The offset rounds to whole pixels, so the moving
   * shape is exactly what release commits.
   */
  function updateDrag(offset: Vector) {
    setSelection((current) =>
      current?.drag === undefined
        ? current
        : current.withDrag({
            ...current.drag,
            offset: { dx: Math.round(offset.dx), dy: Math.round(offset.dy) },
          })
    )
  }

  /**
   * Release: the whole move is one replace, one undo step. It lands only if
   * the shape still stands where the drag found it.
   */
  function endDrag() {
    const drag = selection?.drag
    if (selection === undefined || drag === undefined) return
    setSelection(selection.withDrag(undefined))
    if (
      editable !== undefined &&
      (drag.offset.dx !== 0 || drag.offset.dy !== 0) &&
      annotations[selection.index] === drag.annotation
    ) {
      commit(
        editable,
        historyOf(editable).replaceAnnotation(
          selection.index,
          translated(drag.annotation, drag.offset)
        )
      )
    }
  }

  function cancelDrag() {
    setSelection((current) => current?.withDrag(undefined))
  }

  /**
   * Esc, one rule for every focus: on the capture a selection is released
   * first; anywhere, an untouched capture is discarded. Returns whether Esc
   * acted, so an idle Esc keeps its usual meaning.
   */
  function escape(onSurface: boolean): boolean {
    const activity = { isBusy }
    const action = onSurface
      ? escapeOnSurface(editor, selection, session, activity)
      : escapeInEditor(editor, session, activity)
    if (action === undefined) return false
    if (action.action === "releaseAnnotation") setSelection(undefined)
    else onDiscard(action.id)
    return true
  }

  return {
    editor,
    item,
    canEdit,
    tool,
    setTool,
    color,
    setColor,
    selection,
    selectedAnnotation,
    /** The selected shape as the Reviewer sees it, mid-drag included. */
    displayedSelection:
      selection?.drag === undefined
        ? selectedAnnotation
        : translated(selection.drag.annotation, selection.drag.offset),
    canUndo: editable !== undefined && historyOf(editable).canUndo,
    canRedo: editable !== undefined && historyOf(editable).canRedo,
    canDiscard: editor.allowsDiscard({ isBusy }),
    select,
    open,
    step,
    canStep,
    setPendingLabelDraft,
    add,
    undo,
    redo,
    indexAt,
    selectAt,
    deleteAt,
    deleteSelected,
    nudge,
    beginDrag,
    updateDrag,
    endDrag,
    cancelDrag,
    escape,
  }
}

export type Editor = ReturnType<typeof useEditor>
