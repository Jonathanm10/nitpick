import Foundation
import NitpickCore
import Testing

/// File all's one content blocker lives in the core, so the shell's button
/// enablement and the reason it shows beside the button read the same
/// predicate and can never disagree: an editable Finding with no summary.
@Suite("Findings needing a summary")
struct FindingsNeedingSummaryTests {
    @Test("blank and whitespace-only summaries block, in tray order")
    func blankSummariesBlockInTrayOrder() {
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Titled"))
        let untitled = session.addFinding(IssueFilingTests.finding(summary: ""))
        session.addFinding(IssueFilingTests.finding(summary: "Also titled"))
        let whitespace = session.addFinding(IssueFilingTests.finding(summary: "  \n"))

        #expect(session.findingsNeedingSummary == [untitled, whitespace])
    }

    @Test("a fully summarized tray has nothing blocking it")
    func summarizedTrayHasNoBlockers() {
        let session = FilingPhaseScenarioTests.session(["One", "Two"])

        #expect(session.findingsNeedingSummary.isEmpty)
    }

    @Test("typing a summary unblocks the Finding")
    func summarizingUnblocks() {
        var session = IssueFilingTests.session
        let id = session.addFinding(IssueFilingTests.finding(summary: ""))
        #expect(session.findingsNeedingSummary == [id])

        session.updateFinding(id: id) { $0.summary = "Now it has one" }

        #expect(session.findingsNeedingSummary.isEmpty)
    }

    @Test("a filed Finding never blocks; only the untitled capture after it does")
    func filedFindingsNeverBlock() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        SessionTrayScenarioTests.enqueueTagLookups(on: transport)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)

        let outcome = await core.fileAll(in: FilingPhaseScenarioTests.session(["Solo"]))
        try #require(outcome.failure == nil)
        var session = outcome.session
        let fresh = session.addFinding(IssueFilingTests.finding(summary: ""))

        #expect(session.findingsNeedingSummary == [fresh])
    }
}
