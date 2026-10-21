import NitpickCore
import Testing

/// A Review Session opening or closing resets the shell's per-session
/// state. Start review sets up the running Build and the triage schema
/// before the session opens, so the two edges must not reset the same things.
@Suite("Session edge")
struct SessionEdgeTests {
    @Test("an edit to an open session, or a session that stays closed, is no edge")
    func inPlaceChangeIsNoEdge() {
        #expect(SessionEdge(wasOpen: true, isOpen: true) == nil)
        #expect(SessionEdge(wasOpen: false, isOpen: false) == nil)
    }

    @Test("opening keeps the Build and schema Start review set up just before it")
    func openingKeepsStartReviewsRun() throws {
        let edge = try #require(SessionEdge(wasOpen: false, isOpen: true))

        #expect(edge == .opened)
        #expect(!edge.dropsRunAndSchema)
    }

    @Test("closing drops the running Build and the schema")
    func closingDropsTheRun() throws {
        let edge = try #require(SessionEdge(wasOpen: true, isOpen: false))

        #expect(edge == .closed)
        #expect(edge.dropsRunAndSchema)
    }

    @Test("opening dismisses a held filing result, and closing leaves the one File all is about to hold")
    func onlyOpeningDismissesTheFilingResult() {
        #expect(SessionEdge.opened.dismissesFilingResult)
        #expect(!SessionEdge.closed.dismissesFilingResult)
    }
}
