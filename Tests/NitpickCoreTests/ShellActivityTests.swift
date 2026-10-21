import Foundation
import NitpickCore
import Testing

/// The shell's run facts: what is running, and how the last File all ended.
/// The File all button and the frozen Tray rows read these.
@Suite("Shell activity")
struct ShellActivityTests {
    @Test("a fresh shell is idle")
    func freshShellIsIdle() {
        let activity = ShellActivity()

        #expect(!activity.isBusy)
        #expect(!activity.isFiling)
        #expect(activity.filingFailure == nil)
    }

    @Test("a File all run is busy and filing until it ends")
    func filingRunIsBusyAndFiling() {
        var activity = ShellActivity()

        activity.begin(.filing)
        #expect(activity.isBusy)
        #expect(activity.isFiling)

        activity.end()
        #expect(!activity.isBusy)
        #expect(!activity.isFiling)
    }

    @Test("other work is busy but not filing")
    func otherWorkIsBusyButNotFiling() {
        var activity = ShellActivity()

        activity.begin(.other)

        #expect(activity.isBusy)
        #expect(!activity.isFiling)
    }

    @Test("a filing failure survives unrelated work")
    func filingFailureSurvivesUnrelatedWork() {
        var activity = ShellActivity()
        activity.begin(.filing)
        activity.recordFilingFailure("The network connection was lost.")
        activity.end()

        activity.begin(.other)
        activity.end()

        #expect(activity.filingFailure?.message == "The network connection was lost.")
    }

    @Test("the next File all run forgets the last failure")
    func nextFilingRunForgetsTheFailure() {
        var activity = ShellActivity()
        activity.begin(.filing)
        activity.recordFilingFailure("The request timed out.")
        activity.end()

        activity.begin(.filing)

        #expect(activity.filingFailure == nil)
    }

    @Test("a session edge forgets the last failure")
    func sessionEdgeForgetsTheFailure() {
        var activity = ShellActivity()
        activity.recordFilingFailure("The request timed out.")

        activity.forgetFilingFailure()

        #expect(activity.filingFailure == nil)
    }
}
