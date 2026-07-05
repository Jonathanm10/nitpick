import CoreGraphics
import Foundation
import NitpickCore
import Testing

/// Durability (issue 07): Review Sessions and their Findings persist locally
/// as they are created, against a real temporary-directory filesystem — no
/// seam, no mocks (PRD testing decisions). Killing the app and relaunching
/// resumes the open session; a fully filed session becomes a read-only
/// entry in the local history log — never a YouTrack mirror.
@Suite("Crash-safe sessions and history")
struct DurabilityTests {
    /// A fresh core over the given workspace — the relaunch path shares the
    /// workspace (disk survives) and the credential store (Keychain survives).
    static func relaunchedCore(
        workspace: URL,
        transport: FakeHTTPTransport = FakeHTTPTransport(),
        credentials: FakeCredentialStore = FakeCredentialStore()
    ) -> AppCore {
        AppCore(
            environment: .fake(httpTransport: transport, credentialStore: credentials),
            workspaceDirectory: workspace
        )
    }

    /// A core with a saved connection in the given workspace, as the
    /// designer has after settings — consumes two stubs and two requests.
    static func connectedCore(
        transport: FakeHTTPTransport,
        workspace: URL,
        credentials: FakeCredentialStore
    ) async throws -> AppCore {
        let core = relaunchedCore(workspace: workspace, transport: transport, credentials: credentials)
        transport.enqueue(json: YouTrackConnectionTests.userJSON)
        transport.enqueue(json: YouTrackConnectionTests.projectsJSON)
        try await core.connectYouTrack(
            instanceURL: "https://youtrack.example.com/yt", token: "perm:designer-token"
        )
        return core
    }

    // MARK: - Crash-safe resume

    @Test("killing the app mid-session and relaunching restores the open session — tray, descriptions, editable Annotations")
    func resumeAfterKill() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = Self.relaunchedCore(workspace: workspace)

        var session = IssueFilingTests.session
        var annotated = Finding(
            summary: "Button color is off",
            description: "The primary button is #FF0000, the design says #E64545.",
            screenshotPNG: Data([0x89, 0x50, 0x4E, 0x47, 0x01]),
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4"),
            designReference: URL(string: "https://www.figma.com/design/abc/buttons")!
        )
        annotated.add(Annotation(.pen(points: [CGPoint(x: 1, y: 2), CGPoint(x: 3, y: 4)]), color: .yellow))
        annotated.add(Annotation(.arrow(from: CGPoint(x: 5, y: 6), to: CGPoint(x: 7, y: 8))))
        annotated.add(Annotation(.rectangle(CGRect(x: 10, y: 20, width: 30, height: 40)), color: .blue))
        annotated.add(Annotation(.label("Wrong red", at: CGPoint(x: 9, y: 10)), color: .white))
        session.addFinding(annotated)
        let second = session.addFinding(Finding(
            summary: "",
            description: "",
            screenshotPNG: Data([0x89, 0x50, 0x4E, 0x47, 0x02]),
            deviceContext: DeviceContext(
                deviceModel: "iPad Pro 13-inch (M4)", osName: "iOS 26.4",
                accessibilitySettings: ["Dynamic Type XL", "Dark Mode"]
            )
        ))
        try core.saveOpenSession(session)

        // Later edits persist too — the newest save wins.
        session.updateFinding(id: second) { $0.summary = "Label truncates" }
        try core.saveOpenSession(session)

        // The process dies here; a fresh core over the same workspace is
        // the relaunch.
        let relaunched = Self.relaunchedCore(workspace: workspace)
        var resumed = try #require(try relaunched.loadOpenSession())
        #expect(resumed == session)

        // Annotations are still editable after the relaunch (the pre-kill
        // undo history is not carried across it)…
        let first = resumed.tray[0].id
        #expect(!resumed.tray[0].finding.canUndo)
        resumed.updateFinding(id: first) { $0.removeAnnotation(at: 0) }
        #expect(resumed.tray[0].finding.annotations.count == 3)
        #expect(resumed.tray[0].finding.canUndo)
    }

    @Test("nothing saved: loading the open session is nil, not an error")
    func nothingSaved() throws {
        let core = Self.relaunchedCore(workspace: try Fixtures.makeTemporaryDirectory())
        #expect(try core.loadOpenSession() == nil)
    }

    @Test("an abandoned session is cleared: nothing to resurrect on the next launch")
    func clearedSessionStaysGone() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = Self.relaunchedCore(workspace: workspace)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding())
        try core.saveOpenSession(session)

        try core.clearOpenSession()

        #expect(try Self.relaunchedCore(workspace: workspace).loadOpenSession() == nil)
        // Clearing when nothing is open is a no-op, not an error.
        try core.clearOpenSession()
    }

    /// End Review's persistence contract (issue 02): ending a session
    /// discards its unfiled Findings for good — the cleared slot leaves a
    /// relaunch nothing to restore. Prior art: filing clears the slot the
    /// same way; this pins the clear-with-unfiled-work path End Review
    /// composes.
    @Test("clearing a persisted open session with unfiled Findings leaves nothing to restore")
    func clearedUnfiledWorkStaysGone() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = Self.relaunchedCore(workspace: workspace)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "First"))
        session.addFinding(IssueFilingTests.finding(summary: "Second"))
        #expect(session.hasUnfiledFindings)
        try core.saveOpenSession(session)

        try core.clearOpenSession()

        #expect(try Self.relaunchedCore(workspace: workspace).loadOpenSession() == nil)
    }

    @Test("a discarded Finding stays discarded after the relaunch")
    func discardSurvives() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = Self.relaunchedCore(workspace: workspace)

        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Keep me"))
        let dropped = session.addFinding(IssueFilingTests.finding(summary: "Not a real problem"))
        try core.saveOpenSession(session)
        session.discardFinding(id: dropped)
        try core.saveOpenSession(session)

        let resumed = try #require(try Self.relaunchedCore(workspace: workspace).loadOpenSession())
        #expect(resumed == session)
        #expect(resumed.tray.map(\.finding.summary) == ["Keep me"])
    }

    @Test("the session-level Design Reference survives the relaunch")
    func sessionDesignReferenceSurvives() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = Self.relaunchedCore(workspace: workspace)
        var session = IssueFilingTests.session
        session.designReference = URL(string: "https://www.figma.com/file/sess42/ReviewMe")!
        session.addFinding(IssueFilingTests.finding())
        try core.saveOpenSession(session)

        let resumed = try #require(try Self.relaunchedCore(workspace: workspace).loadOpenSession())
        #expect(resumed == session)
        #expect(resumed.designReference == URL(string: "https://www.figma.com/file/sess42/ReviewMe")!)
    }

    @Test("a corrupt open-session file is a thrown error, not a silently empty state")
    func corruptSessionFile() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = Self.relaunchedCore(workspace: workspace)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding())
        try core.saveOpenSession(session)

        let manifests = try #require(FileManager.default.enumerator(at: workspace, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }
            .filter { $0.lastPathComponent == "session.json" }
        try #require(manifests.count == 1)
        try Data("not json".utf8).write(to: manifests[0])

        #expect(throws: (any Error).self) {
            try Self.relaunchedCore(workspace: workspace).loadOpenSession()
        }
    }

    // MARK: - Crash-safe filing

    @Test("a crash mid-file-all loses no server-acknowledged step: the relaunch resumes mid-ladder and retry files only the remainder")
    func crashMidFiling() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(
            transport: transport, workspace: workspace, credentials: credentials
        )
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "First"))
        session.addFinding(IssueFilingTests.finding(summary: "Second"))
        session.addFinding(IssueFilingTests.finding(summary: "Third"))
        try core.saveOpenSession(session)

        // First files whole; Second's issue is created, then the network
        // dies at its attachments request — and the app dies with it.
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(json: SessionTrayScenarioTests.createdIssue422)
        transport.enqueue(error: URLError(.networkConnectionLost))
        let outcome = await core.fileAll(in: session)
        #expect(outcome.failure != nil)

        // Nothing in memory survives; the relaunch reads back every mark
        // the run recorded before it died.
        let transport2 = FakeHTTPTransport()
        let relaunched = Self.relaunchedCore(
            workspace: workspace, transport: transport2, credentials: credentials
        )
        let resumed = try #require(try relaunched.loadOpenSession())
        #expect(resumed.tray[0].filedIssue == SessionTrayScenarioTests.filedIssue("RM-421"))
        #expect(resumed.tray[1].filingProgress == .issueCreated(issueID: "3-506", idReadable: "RM-422"))
        #expect(!resumed.tray[1].isEditable)
        #expect(resumed.tray[2].isEditable)

        // Retry: Second resumes at its attachments — never a second issue —
        // and Third files fresh.
        transport2.enqueue(json: IssueFilingTests.existingTagJSON)
        transport2.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport2.enqueue(json: IssueFilingTests.appliedTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport2, created: SessionTrayScenarioTests.createdIssue423)
        let retry = await relaunched.fileAll(in: resumed)
        #expect(retry.failure == nil)
        #expect(retry.session.filedIssues == [
            SessionTrayScenarioTests.filedIssue("RM-421"),
            SessionTrayScenarioTests.filedIssue("RM-422"),
            SessionTrayScenarioTests.filedIssue("RM-423"),
        ])
        let base = SessionTrayScenarioTests.base
        #expect(transport2.sentRequests.map(\.url?.absoluteString) == [
            "\(base)/api/tags?fields=id,name&query=design-review&$top=100",
            "\(base)/api/issues/3-506/attachments?fields=id,name",
            "\(base)/api/issues/3-506/tags?fields=id,name",
            "\(base)/api/issues?fields=id,idReadable",
            "\(base)/api/issues/3-507/attachments?fields=id,name",
            "\(base)/api/issues/3-507/tags?fields=id,name",
        ])

        // The fully filed session left the open slot and became history.
        #expect(try relaunched.loadOpenSession() == nil)
        let history = try relaunched.sessionHistory()
        #expect(history.count == 1)
        #expect(history[0].findings.map(\.issue.idReadable) == ["RM-421", "RM-422", "RM-423"])
    }

    // MARK: - History

    @Test("filed sessions land in history with their issue links — read from disk, never from YouTrack")
    func historyIsALocalLog() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(
            transport: transport, workspace: workspace, credentials: credentials
        )

        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Toolbar icon is misaligned"))
        session.addFinding(IssueFilingTests.finding(summary: "Label truncates"))
        try core.saveOpenSession(session)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue422)
        let outcome = await core.fileAll(in: session)
        #expect(outcome.failure == nil)
        #expect(try core.loadOpenSession() == nil)

        // History is a local log: reading it fetches no YouTrack state.
        let requestsBefore = transport.sentRequests.count
        let history = try core.sessionHistory()
        #expect(transport.sentRequests.count == requestsBefore)

        #expect(history == [
            HistoryEntry(
                build: session.build.identity,
                project: session.project,
                startedAt: session.startedAt,
                findings: [
                    HistoryEntry.FiledFinding(
                        summary: "Toolbar icon is misaligned",
                        description: "The primary button is #FF0000, the design says #E64545.",
                        deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4"),
                        issue: SessionTrayScenarioTests.filedIssue("RM-421")
                    ),
                    HistoryEntry.FiledFinding(
                        summary: "Label truncates",
                        description: "The primary button is #FF0000, the design says #E64545.",
                        deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4"),
                        issue: SessionTrayScenarioTests.filedIssue("RM-422")
                    ),
                ],
            )
        ])

        // A later session files: history lists newest first, across a relaunch.
        var later = IssueFilingTests.session
        later.startedAt = session.startedAt.addingTimeInterval(3600)
        later.addFinding(IssueFilingTests.finding(summary: "Spacing is off"))
        try core.saveOpenSession(later)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue423)
        #expect(await core.fileAll(in: later).failure == nil)

        let relaunched = Self.relaunchedCore(workspace: workspace)
        #expect(try relaunched.sessionHistory().map(\.startedAt) == [later.startedAt, session.startedAt])
    }

    @Test("the Design line freezes with the issue: a session-level edit between a failed run and its retry never rewrites history")
    func designReferenceFreezesAtCreation() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(
            transport: transport, workspace: workspace, credentials: credentials
        )
        let referenceA = URL(string: "https://www.figma.com/file/revA/ReviewMe")!
        let referenceB = URL(string: "https://www.figma.com/file/revB/ReviewMe")!
        var session = IssueFilingTests.session
        session.designReference = referenceA
        session.addFinding(IssueFilingTests.finding(summary: "First"))
        session.addFinding(IssueFilingTests.finding(summary: "Second"))
        try core.saveOpenSession(session)

        // First's issue is created under reference A, then the network dies
        // at its attachments request.
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(error: URLError(.networkConnectionLost))
        var outcome = await core.fileAll(in: session)
        #expect(outcome.failure != nil)
        // The reference the issue was filed under is frozen on the item.
        #expect(outcome.session.tray[0].finding.designReference == referenceA)

        // The designer repoints the session before retrying: First's issue
        // already says A on the instance, Second files under B.
        outcome.session.designReference = referenceB
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue422)
        let retry = await core.fileAll(in: outcome.session)
        #expect(retry.failure == nil)

        // First's creation body carried A; Second's carried B.
        let creations = transport.sentRequests
            .filter { $0.url?.path().hasSuffix("api/issues") == true }
            .compactMap { $0.httpBody.map { String(decoding: $0, as: UTF8.self) } }
        try #require(creations.count == 2)
        #expect(creations[0].contains(#"Design: https://www.figma.com/file/revA/ReviewMe\n"#))
        #expect(creations[1].contains(#"Design: https://www.figma.com/file/revB/ReviewMe\n"#))

        // History records what each issue actually says — A, then B.
        let history = try core.sessionHistory()
        try #require(history.count == 1)
        #expect(history[0].findings.map(\.designReference) == [referenceA, referenceB])
    }

    @Test("captures filed after a file-all extend the same session's history entry — never a duplicate")
    func refileKeepsOneEntryPerSession() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(
            transport: transport, workspace: workspace, credentials: credentials
        )

        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "First"))
        try core.saveOpenSession(session)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        let outcome = await core.fileAll(in: session)
        #expect(outcome.failure == nil)

        // The designer keeps reviewing and files once more.
        var again = outcome.session
        again.addFinding(IssueFilingTests.finding(summary: "One more"))
        try core.saveOpenSession(again)
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue422)
        #expect(await core.fileAll(in: again).failure == nil)

        let history = try core.sessionHistory()
        #expect(history.count == 1)
        #expect(history[0].findings.map(\.issue.idReadable) == ["RM-421", "RM-422"])
    }

    @Test("a fully filed session stuck in the open slot heals on load: recorded to history, slot cleared")
    func healsStuckFiledSession() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(
            transport: transport, workspace: workspace, credentials: credentials
        )

        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Solo"))
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        SessionTrayScenarioTests.enqueueLadder(on: transport, created: SessionTrayScenarioTests.createdIssue421)
        let outcome = await core.fileAll(in: session)
        #expect(outcome.failure == nil)

        // A crash between the last filing mark and the history record
        // leaves a fully filed session in the open slot.
        try core.saveOpenSession(outcome.session)

        let relaunched = Self.relaunchedCore(workspace: workspace)
        #expect(try relaunched.loadOpenSession() == nil)
        let history = try relaunched.sessionHistory()
        #expect(history.count == 1)
        #expect(history[0].findings.map(\.issue.idReadable) == ["RM-421"])
    }
}
