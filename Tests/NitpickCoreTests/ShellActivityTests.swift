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

        _ = activity.begin(.filing)
        #expect(activity.isBusy)
        #expect(activity.isFiling)

        activity.end()
        #expect(!activity.isBusy)
        #expect(!activity.isFiling)
    }

    @Test("other work is busy but not filing")
    func otherWorkIsBusyButNotFiling() {
        var activity = ShellActivity()

        _ = activity.begin(.other)

        #expect(activity.isBusy)
        #expect(!activity.isFiling)
    }

    @Test("work that starts while File all runs is refused and filing keeps running")
    func workIsRefusedWhileFiling() {
        var activity = ShellActivity()
        _ = activity.begin(.filing)

        _ = activity.begin(.other)

        #expect(activity.running == .filing)
    }

    @Test("work that starts while other work runs is refused")
    func workIsRefusedWhileOtherWorkRuns() {
        var activity = ShellActivity()
        _ = activity.begin(.other)

        _ = activity.begin(.filing)

        #expect(activity.running == .other)
    }

    @Test("begin reports refusal, and the next run starts once the current one ends")
    func beginReportsAdmission() {
        var activity = ShellActivity()

        let first = activity.begin(.filing)
        let overlapping = activity.begin(.other)
        activity.end()
        let next = activity.begin(.other)

        #expect(first)
        #expect(!overlapping)
        #expect(next)
    }

    @Test("a filing failure survives unrelated work")
    func filingFailureSurvivesUnrelatedWork() {
        var activity = ShellActivity()
        _ = activity.begin(.filing)
        activity.recordFilingFailure("The network connection was lost.")
        activity.end()

        _ = activity.begin(.other)
        activity.end()

        #expect(activity.filingFailure?.message == "The network connection was lost.")
    }

    @Test("the next File all run forgets the last failure")
    func nextFilingRunForgetsTheFailure() {
        var activity = ShellActivity()
        _ = activity.begin(.filing)
        activity.recordFilingFailure("The request timed out.")
        activity.end()

        _ = activity.begin(.filing)

        #expect(activity.filingFailure == nil)
    }
}
