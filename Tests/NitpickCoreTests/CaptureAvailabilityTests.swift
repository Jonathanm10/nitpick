import NitpickCore
import Testing

/// The capture hints name the global chord only while the session holds it,
/// and a refused chord press says why instead of doing nothing.
@Suite("Capture availability")
struct CaptureAvailabilityTests {
    @Test("a held chord shows its keycap and is named in the hints", arguments: [CaptureHotkeyState.registered, .inactive])
    func heldChordIsHinted(state: CaptureHotkeyState) {
        #expect(state.chordKeycap == "⌃⌥⌘N")
        #expect(state.captureHelp == "Capture the current screen (⌘S here, ⌃⌥⌘N from any app).")
        #expect(state.placeholderNote == "or ⌃⌥⌘N from the Simulator")
        #expect(state.takenWarning == nil)
    }

    @Test("a taken chord drops its keycap, warns, and leaves ⌘S as the only capture")
    func takenChordWarns() {
        let state = CaptureHotkeyState.taken

        #expect(state.chordKeycap == nil)
        #expect(state.captureHelp == "Capture the current screen (⌘S).")
        #expect(state.placeholderNote == "Another app holds ⌃⌥⌘N, so capture from the Simulator is off. ⌘S still captures while nitpick is in front.")
        #expect(state.takenWarning == "⌃⌥⌘N is taken by another app")
    }

    @Test("a running review with nothing in flight can capture")
    func readyCaptures() {
        #expect(CaptureRefusal(isReviewing: true, isBusy: false, hasPendingLabelDraft: false) == nil)
    }

    @Test("each blocking fact refuses with its own reason")
    func eachFactRefuses() {
        #expect(CaptureRefusal(isReviewing: false, isBusy: false, hasPendingLabelDraft: false) == .reviewPaused)
        #expect(CaptureRefusal(isReviewing: true, isBusy: true, hasPendingLabelDraft: false) == .busy)
        #expect(CaptureRefusal(isReviewing: true, isBusy: false, hasPendingLabelDraft: true) == .labelDraftPending)
    }

    @Test("a paused review outranks work in flight and an open label")
    func pausedReviewComesFirst() {
        #expect(CaptureRefusal(isReviewing: false, isBusy: true, hasPendingLabelDraft: true) == .reviewPaused)
        #expect(CaptureRefusal(isReviewing: true, isBusy: true, hasPendingLabelDraft: true) == .busy)
    }

    @Test("the chord's refusal names the chord and the way out")
    func refusalMessages() {
        #expect(CaptureRefusal.reviewPaused.hotkeyMessage == "⌃⌥⌘N captured nothing because the review is paused. Resume review, then capture again.")
        #expect(CaptureRefusal.busy.hotkeyMessage == "⌃⌥⌘N captured nothing because nitpick was busy. Try again in a moment.")
        #expect(CaptureRefusal.labelDraftPending.hotkeyMessage == "⌃⌥⌘N captured nothing because a text label is still open. Finish it, then capture again.")
    }
}
