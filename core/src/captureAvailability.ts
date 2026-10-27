// Ported from Sources/NitpickCore/CaptureAvailability.swift, without the
// global hotkey: a page can't hold a system-wide chord (ADR-0012), so the
// capture chord is the page's own, ⌘S on a Mac and Ctrl+S elsewhere. Callers
// pass its label.

/**
 * The empty capture pane's prompt. A paused review captures nothing, so it
 * points at Resume review instead of promising a chord.
 */
export function capturePlaceholder(
  isReviewing: boolean,
  captureChord: string
): string {
  return isReviewing ? `${captureChord} to capture` : "Resume review to capture"
}

/** Why a capture can't start. */
export type CaptureRefusal = "reviewPaused" | "busy" | "labelDraftPending"

/**
 * Undefined when a capture can start. A paused review comes first, since
 * waiting out the other two would not help.
 */
export function captureRefusal(state: {
  readonly isReviewing: boolean
  readonly isBusy: boolean
  readonly hasPendingLabelDraft: boolean
}): CaptureRefusal | undefined {
  if (!state.isReviewing) return "reviewPaused"
  if (state.isBusy) return "busy"
  if (state.hasPendingLabelDraft) return "labelDraftPending"
  return undefined
}

/** What the page says when the capture chord meets a refusal. */
export function captureRefusalMessage(
  refusal: CaptureRefusal,
  captureChord: string
): string {
  switch (refusal) {
    case "reviewPaused":
      return `${captureChord} captured nothing because the review is paused. Resume review, then capture again.`
    case "busy":
      return `${captureChord} captured nothing because nitpick was busy. Try again in a moment.`
    case "labelDraftPending":
      return `${captureChord} captured nothing because a text label is still open. Finish it, then capture again.`
  }
}
