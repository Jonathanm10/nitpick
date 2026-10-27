// Ports Tests/NitpickCoreTests/EditorEscapeTests.swift. ShellActivity is
// issue 06's; the Esc rule reads only whether work is running.
import { describe, expect, test } from "vitest"
import {
  AnnotationSelection,
  EditorState,
  escapeInEditor,
  escapeOnSurface,
} from "../src/editorState.ts"
import { addFinding } from "../src/reviewSession.ts"
import * as fixtures from "./fixtures.ts"

const idle = { isBusy: false }
const filing = { isBusy: true }

function editor({ summary = "" } = {}) {
  const { session, id } = addFinding(
    fixtures.session,
    fixtures.finding({ summary, description: "" })
  )
  const selected = new EditorState().selecting(id, session)
  if (selected === undefined) throw new Error("the selection was refused")
  return { editor: selected, session, id }
}

function selectionOn(target: EditorState) {
  return new AnnotationSelection<number>(0, target)
}

describe("Editor Esc rule", () => {
  test("on the surface, a selected Annotation is released before a pristine Finding is discarded", () => {
    const { editor: current, session } = editor()

    expect(
      escapeOnSurface(current, selectionOn(current), session, idle)
    ).toEqual({ action: "releaseAnnotation" })
  })

  test("on the surface with nothing selected, a pristine Finding is discarded", () => {
    const { editor: current, session, id } = editor()

    expect(escapeOnSurface(current, undefined, session, idle)).toEqual({
      action: "discard",
      id,
    })
  })

  test("a selection made on an earlier target does not block the discard", () => {
    const { editor: current, session, id } = editor()
    const stale = selectionOn(new EditorState())

    expect(escapeOnSurface(current, stale, session, idle)).toEqual({
      action: "discard",
      id,
    })
  })

  test("the editor scope discards a pristine Finding and never releases a selection", () => {
    const { editor: current, session, id } = editor()

    expect(escapeInEditor(current, session, idle)).toEqual({
      action: "discard",
      id,
    })
  })

  test("a Finding with a summary is never discarded, from either scope", () => {
    const { editor: current, session } = editor({
      summary: "Header title sits 4 pt too high",
    })

    expect(escapeInEditor(current, session, idle)).toBeUndefined()
    expect(escapeOnSurface(current, undefined, session, idle)).toBeUndefined()
  })

  test("Esc never discards while File all runs", () => {
    const { editor: current, session } = editor()

    expect(escapeInEditor(current, session, filing)).toBeUndefined()
    expect(escapeOnSurface(current, undefined, session, filing)).toBeUndefined()
  })

  test("Esc never discards while a label draft pins the editor", () => {
    const { editor: current, session } = editor()
    const pinned = current.withPendingLabelDraft(true)

    expect(escapeInEditor(pinned, session, idle)).toBeUndefined()
  })

  // Swift runs no work, .other and .filing; both kinds of work are busy.
  test.each([
    { running: "none", isBusy: false, labelDraft: false },
    { running: "none", isBusy: false, labelDraft: true },
    { running: "other", isBusy: true, labelDraft: false },
    { running: "other", isBusy: true, labelDraft: true },
    { running: "filing", isBusy: true, labelDraft: false },
    { running: "filing", isBusy: true, labelDraft: true },
  ])(
    "Esc discards a pristine Finding exactly when the Tray's discard is allowed (running $running, label draft $labelDraft)",
    ({ isBusy, labelDraft }) => {
      const { editor: current, session, id } = editor()
      const target = current.withPendingLabelDraft(labelDraft)
      const activity = { isBusy }

      const allowed = target.allowsDiscard(activity)

      expect(allowed).toBe(!isBusy && !labelDraft)
      expect(escapeInEditor(target, session, activity)).toEqual(
        allowed ? { action: "discard", id } : undefined
      )
    }
  )

  test("with no Finding in the editor, Esc does nothing", () => {
    const session = fixtures.session

    expect(escapeInEditor(new EditorState(), session, idle)).toBeUndefined()
    expect(
      escapeOnSurface(new EditorState(), undefined, session, idle)
    ).toBeUndefined()
  })
})
