// Ports Tests/NitpickCoreTests/CaptureAvailabilityTests.swift. The cases about
// the global hotkey's keycap, help and taken warning are not ported: the
// hotkey is dropped (ADR-0012). The refusal messages name the page's own
// capture chord instead of ⌃⌥⌘N.
import { describe, expect, test } from "vitest"
import {
  capturePlaceholder,
  captureRefusal,
  captureRefusalMessage,
} from "../src/captureAvailability.ts"

describe("Capture availability", () => {
  test("a running review's empty pane names the capture chord", () => {
    expect(capturePlaceholder(true, "⌘S")).toBe("⌘S to capture")
    expect(capturePlaceholder(true, "Ctrl+S")).toBe("Ctrl+S to capture")
  })

  test("a paused review's empty pane points at Resume review, whatever the chord", () => {
    expect(capturePlaceholder(false, "⌘S")).toBe("Resume review to capture")
    expect(capturePlaceholder(false, "Ctrl+S")).toBe("Resume review to capture")
  })

  test("a running review with nothing in flight can capture", () => {
    expect(
      captureRefusal({
        isReviewing: true,
        isBusy: false,
        hasPendingLabelDraft: false,
      })
    ).toBeUndefined()
  })

  test("each blocking fact refuses with its own reason", () => {
    expect(
      captureRefusal({
        isReviewing: false,
        isBusy: false,
        hasPendingLabelDraft: false,
      })
    ).toBe("reviewPaused")
    expect(
      captureRefusal({
        isReviewing: true,
        isBusy: true,
        hasPendingLabelDraft: false,
      })
    ).toBe("busy")
    expect(
      captureRefusal({
        isReviewing: true,
        isBusy: false,
        hasPendingLabelDraft: true,
      })
    ).toBe("labelDraftPending")
  })

  test("a paused review outranks work in flight and an open label", () => {
    expect(
      captureRefusal({
        isReviewing: false,
        isBusy: true,
        hasPendingLabelDraft: true,
      })
    ).toBe("reviewPaused")
    expect(
      captureRefusal({
        isReviewing: true,
        isBusy: true,
        hasPendingLabelDraft: true,
      })
    ).toBe("busy")
  })

  test("the chord's refusal names the chord and the way out", () => {
    expect(captureRefusalMessage("reviewPaused", "⌘S")).toBe(
      "⌘S captured nothing because the review is paused. Resume review, then capture again."
    )
    expect(captureRefusalMessage("busy", "⌘S")).toBe(
      "⌘S captured nothing because nitpick was busy. Try again in a moment."
    )
    expect(captureRefusalMessage("labelDraftPending", "Ctrl+S")).toBe(
      "Ctrl+S captured nothing because a text label is still open. Finish it, then capture again."
    )
  })
})
