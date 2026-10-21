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
    func filingRunIsBusyAndFiling() throws {
        var activity = ShellActivity()

        try activity.begin(.filing)
        #expect(activity.isBusy)
        #expect(activity.isFiling)

        activity.end()
        #expect(!activity.isBusy)
        #expect(!activity.isFiling)
    }

    @Test("other work is busy but not filing")
    func otherWorkIsBusyButNotFiling() throws {
        var activity = ShellActivity()

        try activity.begin(.other)

        #expect(activity.isBusy)
        #expect(!activity.isFiling)
    }

    @Test("work that starts while File all runs is refused and filing keeps running")
    func workIsRefusedWhileFiling() throws {
        var activity = ShellActivity()
        try activity.begin(.filing)

        #expect(throws: ShellActivity.Busy.self) { try activity.begin(.other) }
        #expect(activity.running == .filing)
    }

    @Test("work that starts while other work runs is refused")
    func workIsRefusedWhileOtherWorkRuns() throws {
        var activity = ShellActivity()
        try activity.begin(.other)

        #expect(throws: ShellActivity.Busy.self) { try activity.begin(.filing) }
        #expect(activity.running == .other)
    }

    @Test("a refusal is an error with a message the designer can read")
    func refusalSpeaksToTheDesigner() throws {
        var activity = ShellActivity()
        try activity.begin(.other)

        let refusal = #expect(throws: ShellActivity.Busy.self) { try activity.begin(.other) }

        #expect(refusal?.errorDescription?.isEmpty == false)
    }

    @Test("the next run starts once the current one ends")
    func nextRunStartsAfterTheCurrentOneEnds() throws {
        var activity = ShellActivity()
        try activity.begin(.filing)
        activity.end()

        try activity.begin(.other)

        #expect(activity.running == .other)
    }

    @Test("a filing failure survives unrelated work")
    func filingFailureSurvivesUnrelatedWork() throws {
        var activity = ShellActivity()
        try activity.begin(.filing)
        activity.recordFilingFailure("The network connection was lost.")
        activity.end()

        try activity.begin(.other)
        activity.end()

        #expect(activity.filingFailure?.message == "The network connection was lost.")
    }

    @Test("the next File all run forgets the last failure")
    func nextFilingRunForgetsTheFailure() throws {
        var activity = ShellActivity()
        try activity.begin(.filing)
        activity.recordFilingFailure("The request timed out.")
        activity.end()

        try activity.begin(.filing)

        #expect(activity.filingFailure == nil)
    }
}
