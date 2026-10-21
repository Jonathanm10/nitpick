import Foundation
import NitpickCore
import Testing

/// Typed text saves once typing pauses, and steady typing still saves
/// every couple of seconds. Time is passed in, so no test waits.
@Suite("Typing save")
struct TypingSaveTests {
    let start = ContinuousClock.now

    func at(_ milliseconds: Int) -> ContinuousClock.Instant {
        start + .milliseconds(milliseconds)
    }

    @Test("nothing is pending before the first keystroke")
    func idle() {
        #expect(!TypingSave().isPending)
    }

    @Test("a keystroke is due half a second later")
    func singleKeystroke() {
        var save = TypingSave()

        #expect(save.keystroke(at: at(0)) == at(500))
        #expect(save.isPending)
    }

    @Test("each keystroke inside the pause pushes the save back")
    func keystrokesDeferTheSave() {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))
        _ = save.keystroke(at: at(300))

        #expect(save.keystroke(at: at(600)) == at(1100))
    }

    @Test("steady typing saves two seconds after its first unsaved keystroke")
    func steadyTypingIsCapped() {
        var save = TypingSave()
        var due = at(0)
        for keystroke in stride(from: 0, through: 1900, by: 100) {
            due = save.keystroke(at: at(keystroke))
        }

        #expect(due == at(2000))
    }

    @Test("a save clears the pending text and the next keystroke starts a fresh window")
    func saveStartsAFreshWindow() {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))
        _ = save.keystroke(at: at(1900))

        save.saved()
        #expect(!save.isPending)
        #expect(save.keystroke(at: at(1950)) == at(2450))
    }

    @Test("a keystroke after a missed deadline is due at once")
    func overdueSaveIsDueNow() {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))

        #expect(save.keystroke(at: at(2500)) == at(2000))
    }
}
