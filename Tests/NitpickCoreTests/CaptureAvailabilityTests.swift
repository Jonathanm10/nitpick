import NitpickCore
import Testing

/// The capture hints name the global chord only while the session holds it.
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
}
