import Foundation
import NitpickCore
import Testing

/// Next and Previous Finding walk the Tray as the designer sees it, newest
/// first, and stop at either end instead of wrapping.
@Suite("Tray navigation")
struct TrayNavigationTests {
    /// Three Findings captured oldest to newest, so the Tray shows
    /// `newest`, `middle`, `oldest` from top to bottom.
    static func threeFindings() -> (session: ReviewSession, oldest: TrayItem.ID, middle: TrayItem.ID, newest: TrayItem.ID) {
        var session = IssueFilingTests.session
        let oldest = session.addFinding(IssueFilingTests.finding(summary: "Oldest"))
        let middle = session.addFinding(IssueFilingTests.finding(summary: "Middle"))
        let newest = session.addFinding(IssueFilingTests.finding(summary: "Newest"))
        return (session, oldest, middle, newest)
    }

    @Test("an empty tray has nowhere to go")
    func emptyTray() {
        let session = IssueFilingTests.session

        #expect(session.finding(.next, from: nil) == nil)
        #expect(session.finding(.previous, from: nil) == nil)
    }

    @Test("with no selection, Next enters at the top row and Previous at the bottom row")
    func noSelectionEntersAtTheEnds() {
        let (session, oldest, _, newest) = Self.threeFindings()

        #expect(session.finding(.next, from: nil) == newest)
        #expect(session.finding(.previous, from: nil) == oldest)
    }

    @Test("Next moves down the Tray and Previous moves up")
    func stepsFollowTheDisplayOrder() {
        let (session, oldest, middle, newest) = Self.threeFindings()

        #expect(session.finding(.next, from: newest) == middle)
        #expect(session.finding(.next, from: middle) == oldest)
        #expect(session.finding(.previous, from: oldest) == middle)
        #expect(session.finding(.previous, from: middle) == newest)
    }

    @Test("neither step wraps past an end")
    func noWraparound() {
        let (session, oldest, _, newest) = Self.threeFindings()

        #expect(session.finding(.next, from: oldest) == nil)
        #expect(session.finding(.previous, from: newest) == nil)
    }

    @Test("a current ID no longer in the tray steps like no selection")
    func unknownIDActsAsNoSelection() {
        let (session, oldest, _, newest) = Self.threeFindings()

        #expect(session.finding(.next, from: UUID()) == newest)
        #expect(session.finding(.previous, from: UUID()) == oldest)
    }

    @Test("a filed row is a stop like any other")
    func filedRowIsReachable() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        let (session, oldest, middle, _) = Self.threeFindings()
        SessionTrayScenarioTests.enqueueTagLookups(on: transport)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(error: URLError(.networkConnectionLost))

        let filed = await core.fileAll(in: session).session

        #expect(filed.tray.first { $0.id == oldest }?.filedIssue != nil)
        #expect(filed.finding(.next, from: middle) == oldest)
        #expect(filed.finding(.previous, from: nil) == oldest)
    }

    @Test("the editor steps to the next row and opens it fresh")
    func editorStepsToTheNextRow() throws {
        let (session, _, middle, newest) = Self.threeFindings()
        let editor = try #require(EditorState().selecting(newest, in: session))

        let next = try #require(editor.stepping(.next, in: session))

        #expect(next.target == middle)
        #expect(next.generation != editor.generation)
    }

    @Test("a pending text label pins the editor, so neither step moves it")
    func pendingLabelPinsTheEditor() throws {
        let (session, _, middle, _) = Self.threeFindings()
        var editor = try #require(EditorState().selecting(middle, in: session))
        editor.hasPendingLabelDraft = true

        #expect(editor.stepping(.next, in: session) == nil)
        #expect(editor.stepping(.previous, in: session) == nil)
    }

    @Test("with no session there is nothing to step to")
    func noSessionNoStep() {
        #expect(EditorState().stepping(.next, in: nil) == nil)
    }
}
