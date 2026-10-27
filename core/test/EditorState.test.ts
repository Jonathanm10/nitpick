// Ports Tests/NitpickCoreTests/EditorStateTests.swift. The Swift suite builds
// a ReviewSession; that arrives with issue 03, so these cases pass the one
// thing EditorState reads from it: the IDs of its Tray items.
import { describe, expect, test } from "vitest"
import {
  AnnotationSelection,
  annotationDrag,
  EditorState,
  type EditorSession,
} from "../src/index.ts"

let nextID = 0

function session(findings: number): { session: EditorSession; ids: string[] } {
  const ids = Array.from({ length: findings }, () => `TRAY-ITEM-${++nextID}`)
  return { session: { tray: ids.map((id) => ({ id })) }, ids }
}

function selected(editor: EditorState | undefined): EditorState {
  if (!editor) throw new Error("the selection was refused")
  return editor
}

describe("Editor retargeting", () => {
  test("a capture opens its Finding in a fresh editor: a new captureID, no label draft, no Design Snapshot error", () => {
    const { session: open, ids } = session(2)
    const editor = selected(new EditorState().selecting(ids[0]!, open))

    const next = new EditorState(ids[1])

    expect(next.target).toBe(ids[1])
    expect(next.generation).not.toBe(editor.generation)
    expect(next.hasPendingLabelDraft).toBe(false)
    expect(next.designSnapshotError).toBeUndefined()
  })

  test("a tray selection opens a fresh editor and clears the Design Snapshot error", () => {
    const { session: open, ids } = session(2)
    const editor = selected(
      new EditorState().selecting(ids[0]!, open)
    ).withDesignSnapshotError("Moodboard.gif: unsupported format")

    const next = selected(editor.selecting(ids[1]!, open))

    expect(next.target).toBe(ids[1])
    expect(next.generation).not.toBe(editor.generation)
    expect(next.designSnapshotError).toBeUndefined()
    expect(next.hasPendingLabelDraft).toBe(false)
  })

  test("a tray selection is refused while a label draft pins the editor", () => {
    const { session: open, ids } = session(2)
    const editor = selected(
      new EditorState().selecting(ids[0]!, open)
    ).withPendingLabelDraft(true)

    expect(editor.selecting(ids[1]!, open)).toBeUndefined()
  })

  test("selecting the current target, or with no open session, is refused", () => {
    const { session: open, ids } = session(2)
    const editor = selected(new EditorState().selecting(ids[0]!, open))

    expect(editor.selecting(ids[0]!, open)).toBeUndefined()
    expect(editor.selecting(ids[1]!, undefined)).toBeUndefined()
  })

  test("selecting an item that is not in the session's tray is refused", () => {
    const { session: open } = session(1)
    const { ids: elsewhere } = session(1)

    expect(new EditorState().selecting(elsewhere[0]!, open)).toBeUndefined()
  })

  test("closing the editor drops the target, the label draft, and the Design Snapshot error", () => {
    const { session: open, ids } = session(1)
    const editor = selected(new EditorState().selecting(ids[0]!, open))
      .withPendingLabelDraft(true)
      .withDesignSnapshotError("Moodboard.gif: unsupported format")

    const closed = new EditorState()

    expect(closed.target).toBeUndefined()
    expect(closed.generation).not.toBe(editor.generation)
    expect(closed.hasPendingLabelDraft).toBe(false)
    expect(closed.designSnapshotError).toBeUndefined()
  })

  test("an Annotation selection belongs only to the target it was made on", () => {
    const { session: open, ids } = session(2)
    const editor = selected(new EditorState().selecting(ids[0]!, open))
    const selection = new AnnotationSelection<number>(0, editor)
    const drafting = editor.withPendingLabelDraft(true)

    expect(selection.belongs(drafting)).toBe(true)
    expect(selection.belongs(new EditorState(ids[1]))).toBe(false)
    expect(selection.belongs(selected(editor.selecting(ids[1]!, open)))).toBe(
      false
    )
    expect(selection.belongs(new EditorState())).toBe(false)
  })
})

describe("Annotation selection after a delete", () => {
  const editor = new EditorState()

  test("deleting an earlier Annotation shifts the selection down by one", () => {
    const selection = new AnnotationSelection<number>(2, editor)

    expect(selection.removingAnnotation(0)?.index).toBe(1)
  })

  test("deleting a later Annotation keeps the selection", () => {
    const selection = new AnnotationSelection<number>(0, editor)

    expect(selection.removingAnnotation(2)?.index).toBe(0)
  })

  test("deleting the selected Annotation drops the selection", () => {
    const selection = new AnnotationSelection<number>(2, editor)

    expect(selection.removingAnnotation(2)).toBeUndefined()
  })

  test("a delete drops an in-flight drag and keeps the selection on its target", () => {
    const selection = new AnnotationSelection<number>(3, editor).withDrag(
      annotationDrag(
        {
          kind: "rectangle",
          color: "red",
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
        7
      )
    )

    const next = selection.removingAnnotation(1)

    expect(next?.index).toBe(2)
    expect(next?.drag).toBeUndefined()
    expect(next?.belongs(editor)).toBe(true)
  })
})
