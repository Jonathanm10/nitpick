import { isPristine, type ReviewSession } from "./review-session.ts"
import { newUUID } from "./uuid.ts"

/**
 * The Editor's target. Pointing the Editor elsewhere builds a fresh value, so
 * every field starts over on every capture, Tray selection and close.
 */
export interface EditorState {
  /** Absent hides the Editor. */
  readonly target?: string
  /**
   * New with every value: it resets the annotation surface's in-flight
   * draft, and stamps the Annotation selections made on this target.
   */
  readonly generation: string
  /**
   * A placed, uncommitted text label pins the Editor: retargeting first would
   * land its commit on the wrong Finding.
   */
  readonly hasPendingLabelDraft: boolean
}

/** Never refused, unlike a selection: the capture gate refuses a pinned Editor. */
export function openEditor(target?: string): EditorState {
  return { target, generation: newUUID(), hasPendingLabelDraft: false }
}

/**
 * The Editor opened fresh on a Tray item, or undefined when that is refused:
 * it is already the target, a label draft pins the Editor, or the item is
 * not in the session's Tray.
 */
export function selectInEditor(
  editor: EditorState,
  item: string,
  session: ReviewSession | undefined
): EditorState | undefined {
  if (editor.target === item || editor.hasPendingLabelDraft) return undefined
  if (!session?.tray.some((candidate) => candidate.id === item)) {
    return undefined
  }
  return openEditor(item)
}

/** Whether any work runs: ShellActivity's `isBusy`. */
export interface Activity {
  readonly isBusy: boolean
}

/** Never while work runs: filing works on a copy of the session. */
export function editorAllowsDiscard(
  editor: EditorState,
  activity: Activity
): boolean {
  return !editor.hasPendingLabelDraft && !activity.isBusy
}

/**
 * What Esc does in the Editor: release a selected Annotation first,
 * otherwise discard a pristine Finding, the mis-capture case.
 */
export type EditorEscape =
  | { readonly action: "releaseAnnotation" }
  | { readonly action: "discard"; readonly id: string }

/**
 * Esc in the Editor at large, where a text field may hold focus: it never
 * releases a selection, so Esc in Summary keeps standard field behaviour.
 */
export function escapeInEditor(
  editor: EditorState,
  session: ReviewSession | undefined,
  activity: Activity
): EditorEscape | undefined {
  if (!editorAllowsDiscard(editor, activity)) return undefined
  const item = session?.tray.find((candidate) => candidate.id === editor.target)
  if (item === undefined || !isPristine(item)) return undefined
  return { action: "discard", id: item.id }
}

/**
 * Esc on the annotation surface. A selection made on an earlier target, with
 * another generation, no longer counts.
 */
export function escapeOnSurface(
  editor: EditorState,
  selection: { readonly generation: string } | undefined,
  session: ReviewSession | undefined,
  activity: Activity
): EditorEscape | undefined {
  if (selection?.generation === editor.generation) {
    return { action: "releaseAnnotation" }
  }
  return escapeInEditor(editor, session, activity)
}
