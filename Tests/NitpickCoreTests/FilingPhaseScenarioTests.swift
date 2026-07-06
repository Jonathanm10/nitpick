import Foundation
import NitpickCore
import Synchronization
import Testing

/// Filing phase is a pure derivation of the tray plus the shell's run facts:
/// the core only says what the marks mean; the shell decides whether the run
/// is still active or already stopped by a failure.
@Suite("Filing phase derivation")
struct FilingPhaseScenarioTests {
    static let base = SessionTrayScenarioTests.base

    static func enqueueLadder(on transport: FakeHTTPTransport, created: String) {
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: created)
    }

    static func connectedCore(transport: FakeHTTPTransport) async throws -> AppCore {
        try await IssueFilingTests.connectedCore(transport: transport)
    }

    static func session(_ summaries: [String]) -> ReviewSession {
        var session = IssueFilingTests.session
        for summary in summaries {
            session.addFinding(IssueFilingTests.finding(summary: summary))
        }
        return session
    }

    @Test("an unfiled-only tray is idle with the correct count")
    func idleWhenOnlyUnfiledWorkRemains() {
        let session = Self.session(["One untouched finding"])

        #expect(session.filingPhase(isRunning: false, stoppedByFailure: false)
            == .idle(unfiled: 1))
    }

    @Test("an empty tray is idle, never a vacuous done")
    func emptyTrayIsIdle() {
        let session = Self.session([])

        #expect(session.filingPhase(isRunning: false, stoppedByFailure: false)
            == .idle(unfiled: 0))
    }

    @Test("mid-run progress reports the real acknowledged count over the whole tray")
    func filingWhileRunningTracksAcknowledgedMarks() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        let session = Self.session(["First", "Second", "Third"])
        let progress = Mutex<[ReviewSession]>([])

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        Self.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue422)
        transport.enqueue(error: URLError(.networkConnectionLost))

        let outcome = await core.fileAll(in: session, onProgress: { updated in
            progress.withLock { $0.append(updated) }
        })

        let snapshots = progress.withLock { $0 }
        try #require(snapshots.count == 2)
        #expect(snapshots[0].filingPhase(isRunning: true, stoppedByFailure: false)
            == .filing(completed: 1, of: 3))
        #expect(snapshots[1].filingPhase(isRunning: true, stoppedByFailure: false)
            == .filing(completed: 2, of: 3))
        #expect(outcome.session.filingPhase(isRunning: false, stoppedByFailure: true)
            == .remaining(unfiled: 1))
    }

    @Test("a failed run leaves the acked marks standing and reports the remaining work")
    func remainingAfterFailureKeepsAcknowledgedMarks() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        let session = Self.session(["First", "Second", "Third"])

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(error: URLError(.timedOut))

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure is URLError)
        #expect(outcome.session.tray[0].filedIssue == SessionTrayScenarioTests.filedIssue("RM-421"))
        #expect(outcome.session.tray[1].isEditable)
        #expect(outcome.session.tray[2].isEditable)
        #expect(outcome.session.filingPhase(isRunning: false, stoppedByFailure: true)
            == .remaining(unfiled: 2))
    }

    @Test("a fully filed session is done because nothing remains unfiled")
    func allFiledWhenNothingRemains() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        let session = Self.session(["Solo"])

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure == nil)
        #expect(outcome.session.filingPhase(isRunning: false, stoppedByFailure: false)
            == .allFiled(count: 1))
    }

    @Test("progress observation fires once per newly-filed item and stops when the run fails")
    func progressHookStopsAtFailure() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        let session = Self.session(["First", "Second", "Third"])
        let progress = Mutex<[Int]>([])

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        Self.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue422)
        transport.enqueue(error: URLError(.networkConnectionLost))

        let outcome = await core.fileAll(in: session, onProgress: { updated in
            progress.withLock { counts in
                counts.append(updated.filedIssues.count)
            }
        })

        #expect(outcome.failure is URLError)
        #expect(progress.withLock { $0 } == [1, 2])
        #expect(outcome.session.filingPhase(isRunning: false, stoppedByFailure: true)
            == .remaining(unfiled: 1))
    }
}
