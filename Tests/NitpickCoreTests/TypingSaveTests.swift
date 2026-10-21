import Foundation
import NitpickCore
import Testing

/// Typed text saves once typing pauses, steady typing still saves every
/// couple of seconds, and a failed save stays pending until one succeeds.
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

    @Test("a failed save keeps the text pending and retries two seconds later")
    func failedSaveStaysPending() {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))

        #expect(save.failed(at: at(500)) == at(2500))
        #expect(save.isPending)
        #expect(save.flushes(during: ShellActivity()))
    }

    @Test("a keystroke after a failed save is due by the retry")
    func keystrokeAfterFailureKeepsTheRetry() {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))
        _ = save.failed(at: at(500))

        #expect(save.keystroke(at: at(2400)) == at(2500))
    }

    @Test("a retry that succeeds clears the pending text")
    func retrySucceeds() {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))
        _ = save.failed(at: at(500))

        save.saved()
        #expect(!save.isPending)
        #expect(!save.flushes(during: ShellActivity()))
    }

    @Test("nothing pending never flushes")
    func idleNeverFlushes() {
        #expect(!TypingSave().flushes(during: ShellActivity()))
    }

    @Test("pending text flushes during other work but never while filing owns the session")
    func noFlushWhileFiling() throws {
        var save = TypingSave()
        _ = save.keystroke(at: at(0))
        _ = save.failed(at: at(500))

        var other = ShellActivity()
        try other.begin(.other)
        var filing = ShellActivity()
        try filing.begin(.filing)

        #expect(save.flushes(during: other))
        #expect(!save.flushes(during: filing))
        filing.end()
        #expect(save.flushes(during: filing))
    }
}
