import NitpickCore
import Testing

/// The capture hints name the global chord only while the session holds it,
/// and a refused chord press says why instead of doing nothing.
@Suite("Capture availability")
struct CaptureAvailabilityTests {
    @Test("a held chord shows its keycap and is named in the hints")
    func heldChordIsHinted() {
        let state = CaptureHotkeyState.registered

        #expect(state.chordKeycap == "⌃⌥⌘N")
        #expect(state.captureHelp == "Capture the current screen (⌘S here, ⌃⌥⌘N from any app).")
        #expect(state.takenWarning == nil)
    }

    @Test("a taken chord drops its keycap, warns, and its help names only ⌘S")
    func takenChordWarns() {
        let state = CaptureHotkeyState.taken

        #expect(state.chordKeycap == nil)
        #expect(state.captureHelp == "Capture the current screen (⌘S).")
        #expect(state.takenWarning == "⌃⌥⌘N is unavailable")
    }

    @Test("a taken chord's help offers ⌘S only while the review runs")
    func takenExplanationFollowsTheReview() {
        #expect(CaptureHotkeyState.takenExplanation(isReviewing: true) == "nitpick could not register ⌃⌥⌘N, another app may be using it, so capture from the Simulator is off. ⌘S still captures while nitpick is in front.")
        #expect(CaptureHotkeyState.takenExplanation(isReviewing: false) == "nitpick could not register ⌃⌥⌘N, another app may be using it, so capture from the Simulator is off. Resume review to capture with ⌘S.")
    }

    @Test("a chord not yet registered is neither promised nor warned about")
    func inactiveChordIsSilent() {
        let state = CaptureHotkeyState.inactive

        #expect(state.chordKeycap == nil)
        #expect(state.captureHelp == "Capture the current screen (⌘S).")
        #expect(state.takenWarning == nil)
        #expect(CapturePlaceholder(isReviewing: true, hotkey: .inactive).title == "⌘S to capture")
        #expect(CapturePlaceholder(isReviewing: true, hotkey: .inactive).note == nil)
    }

    @Test("a running review's empty pane names both captures")
    func runningPlaceholder() {
        let placeholder = CapturePlaceholder(isReviewing: true, hotkey: .registered)

        #expect(placeholder.title == "⌘S to capture")
        #expect(placeholder.note == "or ⌃⌥⌘N from the Simulator")
    }

    @Test("a taken chord's empty pane says only ⌘S still captures")
    func takenPlaceholder() {
        let placeholder = CapturePlaceholder(isReviewing: true, hotkey: .taken)

        #expect(placeholder.title == "⌘S to capture")
        #expect(placeholder.note == "nitpick could not register ⌃⌥⌘N, another app may be using it, so capture from the Simulator is off. ⌘S still captures while nitpick is in front.")
    }

    @Test("a paused review's empty pane points at Resume review, whatever the chord", arguments: [CaptureHotkeyState.registered, .taken, .inactive])
    func pausedPlaceholder(hotkey: CaptureHotkeyState) {
        let placeholder = CapturePlaceholder(isReviewing: false, hotkey: hotkey)

        #expect(placeholder.title == "Resume review to capture")
        #expect(placeholder.note == nil)
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
