// Ports Tests/NitpickCoreTests/TypingSaveTests.swift: typed text saves once
// typing pauses, steady typing still saves every couple of seconds, and a
// failed save stays pending until one succeeds.
import { describe, expect, test } from "vitest"
import { ShellActivity } from "../src/shellActivity.ts"
import { TypingSave } from "../src/typingSave.ts"

describe("Typing save", () => {
  test("nothing is pending before the first keystroke", () => {
    expect(new TypingSave().isPending).toBe(false)
  })

  test("a keystroke is due half a second later", () => {
    const { save, due } = new TypingSave().keystroke(0)

    expect(due).toBe(500)
    expect(save.isPending).toBe(true)
  })

  test("each keystroke inside the pause pushes the save back", () => {
    const save = new TypingSave().keystroke(0).save.keystroke(300).save

    expect(save.keystroke(600).due).toBe(1100)
  })

  test("steady typing saves two seconds after its first unsaved keystroke", () => {
    let save = new TypingSave()
    let due = 0
    for (let keystroke = 0; keystroke <= 1900; keystroke += 100) {
      ;({ save, due } = save.keystroke(keystroke))
    }

    expect(due).toBe(2000)
  })

  test("a save clears the pending text and the next keystroke starts a fresh window", () => {
    const typed = new TypingSave().keystroke(0).save.keystroke(1900).save

    const saved = typed.saved()
    expect(saved.isPending).toBe(false)
    expect(saved.keystroke(1950).due).toBe(2450)
  })

  test("a keystroke after a missed deadline is due at once", () => {
    const { save } = new TypingSave().keystroke(0)

    expect(save.keystroke(2500).due).toBe(2000)
  })

  test("a failed save keeps the text pending and retries two seconds later", () => {
    const { save: typed } = new TypingSave().keystroke(0)

    const { save, due } = typed.failed(500)
    expect(due).toBe(2500)
    expect(save.isPending).toBe(true)
    expect(save.flushes(new ShellActivity())).toBe(true)
  })

  test("a keystroke after a failed save is due by the retry", () => {
    const { save } = new TypingSave().keystroke(0).save.failed(500)

    expect(save.keystroke(2400).due).toBe(2500)
  })

  test("a retry that succeeds clears the pending text", () => {
    const { save } = new TypingSave().keystroke(0).save.failed(500)

    const saved = save.saved()
    expect(saved.isPending).toBe(false)
    expect(saved.flushes(new ShellActivity())).toBe(false)
  })

  test("nothing pending never flushes", () => {
    expect(new TypingSave().flushes(new ShellActivity())).toBe(false)
  })

  test("pending text flushes during other work but never while filing owns the session", () => {
    const { save } = new TypingSave().keystroke(0).save.failed(500)

    const other = new ShellActivity().begin("other")
    const filing = new ShellActivity().begin("filing")

    expect(save.flushes(other)).toBe(true)
    expect(save.flushes(filing)).toBe(false)
    expect(save.flushes(filing.end())).toBe(true)
  })
})
