// Ports Tests/NitpickCoreTests/TrayNavigationTests.swift.
import { describe, expect, test } from "vitest"
import { EditorState } from "../src/editorState.ts"
import { addFinding } from "../src/reviewSession.ts"
import { stepEditor, stepInTray } from "../src/trayNavigation.ts"
import { newUUID } from "../src/uuid.ts"
import * as fixtures from "./fixtures.ts"

/**
 * Three Findings captured oldest to newest, so the Tray shows `newest`,
 * `middle`, `oldest` from top to bottom.
 */
function threeFindings() {
  const oldest = addFinding(
    fixtures.session,
    fixtures.finding({ summary: "Oldest" })
  )
  const middle = addFinding(
    oldest.session,
    fixtures.finding({ summary: "Middle" })
  )
  const newest = addFinding(
    middle.session,
    fixtures.finding({ summary: "Newest" })
  )
  return {
    session: newest.session,
    oldest: oldest.id,
    middle: middle.id,
    newest: newest.id,
  }
}

describe("Tray navigation", () => {
  test("an empty tray has nowhere to go", () => {
    expect(stepInTray(fixtures.session, "next")).toBeUndefined()
    expect(stepInTray(fixtures.session, "previous")).toBeUndefined()
  })

  test("with no selection, Next enters at the top row and Previous at the bottom row", () => {
    const { session, oldest, newest } = threeFindings()

    expect(stepInTray(session, "next")).toBe(newest)
    expect(stepInTray(session, "previous")).toBe(oldest)
  })

  test("Next moves down the Tray and Previous moves up", () => {
    const { session, oldest, middle, newest } = threeFindings()

    expect(stepInTray(session, "next", newest)).toBe(middle)
    expect(stepInTray(session, "next", middle)).toBe(oldest)
    expect(stepInTray(session, "previous", oldest)).toBe(middle)
    expect(stepInTray(session, "previous", middle)).toBe(newest)
  })

  test("neither step wraps past an end", () => {
    const { session, oldest, newest } = threeFindings()

    expect(stepInTray(session, "next", oldest)).toBeUndefined()
    expect(stepInTray(session, "previous", newest)).toBeUndefined()
  })

  test("a current ID no longer in the tray steps like no selection", () => {
    const { session, oldest, newest } = threeFindings()

    expect(stepInTray(session, "next", newUUID())).toBe(newest)
    expect(stepInTray(session, "previous", newUUID())).toBe(oldest)
  })

  test("a filed row is a stop like any other", () => {
    const { session, oldest, middle } = threeFindings()

    const filed = fixtures.withFilingProgress(session, oldest, {
      state: "filed",
      issue: fixtures.filedIssue("RM-421"),
    })

    expect(stepInTray(filed, "next", middle)).toBe(oldest)
    expect(stepInTray(filed, "previous")).toBe(oldest)
  })

  test("the editor steps to the next row and opens it fresh", () => {
    const { session, middle, newest } = threeFindings()
    const editor = new EditorState().selecting(newest, session)

    const next = editor && stepEditor(editor, "next", session)

    expect(next?.target).toBe(middle)
    expect(next?.generation).not.toBe(editor?.generation)
  })

  test("a pending text label pins the editor, so neither step moves it", () => {
    const { session, middle } = threeFindings()
    const editor = new EditorState()
      .selecting(middle, session)
      ?.withPendingLabelDraft(true)
    if (editor === undefined) throw new Error("the selection was refused")

    expect(stepEditor(editor, "next", session)).toBeUndefined()
    expect(stepEditor(editor, "previous", session)).toBeUndefined()
  })

  test("with no session there is nothing to step to", () => {
    expect(stepEditor(new EditorState(), "next", undefined)).toBeUndefined()
  })
})
