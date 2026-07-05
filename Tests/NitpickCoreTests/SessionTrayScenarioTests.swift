import Foundation
import NitpickCore
import Testing

/// The uninterrupted-flow half of the Review Session (issue 05): captures
/// drop Findings into the session tray with no filing dialog; the tray is
/// edited and pruned at session end; file-all turns every remaining Finding
/// into exactly one issue and lists the links. Filing is failure-safe:
/// every server-acknowledged step is recorded before the next request
/// fires, so a transport failure mid-run loses nothing and a retry never
/// re-creates what the instance already acknowledged.
@Suite("Session tray and file-all")
struct SessionTrayScenarioTests {
    static let base = "https://youtrack.example.com/yt"

    static let createdIssue421 = #"{"id":"3-505","idReadable":"RM-421","$type":"Issue"}"#
    static let createdIssue422 = #"{"id":"3-506","idReadable":"RM-422","$type":"Issue"}"#
    static let createdIssue423 = #"{"id":"3-507","idReadable":"RM-423","$type":"Issue"}"#

    static func filedIssue(_ idReadable: String) -> FiledIssue {
        FiledIssue(idReadable: idReadable, url: URL(string: "\(base)/issue/\(idReadable)")!)
    }

    /// The stub triple one Finding's happy filing ladder consumes.
    static func enqueueLadder(on transport: FakeHTTPTransport, created: String) {
        transport.enqueue(json: created)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
    }

    // MARK: - The tray

    @Test("captures land in the tray as Findings with their screenshots — no filing traffic until file-all")
    func capturesLandInTray() async throws {
        let temp = try Fixtures.makeTemporaryDirectory()
        let workspace = temp.appendingPathComponent("workspace", isDirectory: true)
        let runner = FakeSubprocessRunner()
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(
                subprocess: runner,
                httpTransport: transport,
                credentialStore: FakeCredentialStore()
            ),
            workspaceDirectory: workspace
        )
        transport.enqueue(json: YouTrackConnectionTests.userJSON)
        transport.enqueue(json: YouTrackConnectionTests.projectsJSON)
        try await core.connectYouTrack(
            instanceURL: "https://youtrack.example.com", token: "perm:designer-token"
        )
        let device = SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)
        var session = IssueFilingTests.session

        // Two captures in a row — each drops straight into the tray, the
        // review keeps flowing.
        let firstPNG = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01])
        let secondPNG = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x02])
        for png in [firstPNG, secondPNG] {
            runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
                try png.write(to: workspace.appendingPathComponent("captures/capture.png"))
            }
            let screenshot = try await core.captureScreen(of: device)
            session.addFinding(Finding(
                summary: "", description: "",
                screenshotPNG: screenshot,
                deviceContext: DeviceContext(device: device)
            ))
        }

        try #require(session.tray.count == 2)
        #expect(session.tray[0].finding.screenshotPNG == firstPNG)
        #expect(session.tray[1].finding.screenshotPNG == secondPNG)
        #expect(session.tray.allSatisfy { $0.isEditable })
        #expect(session.tray.allSatisfy { $0.finding.deviceContext == DeviceContext(device: device) })
        #expect(session.filedIssues.isEmpty)
        // No filing dialog, no filing traffic: nothing beyond the two
        // connect requests ever reached the network.
        #expect(transport.sentRequests.count == 2)
    }

    @Test("tray items are edited in place and discarded before filing")
    func editAndDiscard() throws {
        var session = IssueFilingTests.session
        let kept = session.addFinding(IssueFilingTests.finding(summary: "Keep"))
        let dropped = session.addFinding(IssueFilingTests.finding(summary: "Drop"))

        session.updateFinding(id: kept) {
            $0.summary = "Keep — sharpened"
            $0.description = "Now with reproduction steps."
            $0.add(Annotation(.rectangle(CGRect(x: 40, y: 300, width: 200, height: 120))))
        }
        session.discardFinding(id: dropped)

        try #require(session.tray.count == 1)
        let item = session.tray[0]
        #expect(item.id == kept)
        #expect(item.finding.summary == "Keep — sharpened")
        #expect(item.finding.description == "Now with reproduction steps.")
        #expect(item.finding.annotations.count == 1)
    }

    // MARK: - The drop guard's predicate (issue 05)

    @Test("the tray's filing state drives the unfiled-Findings predicate: empty false, captures true, discard-all false")
    func unfiledFindingsFollowTheTray() throws {
        var session = IssueFilingTests.session
        #expect(!session.hasUnfiledFindings)
        #expect(session.unfiledFindingCount == 0)

        let first = session.addFinding(IssueFilingTests.finding(summary: "First"))
        let second = session.addFinding(IssueFilingTests.finding(summary: "Second"))
        #expect(session.hasUnfiledFindings)
        #expect(session.unfiledFindingCount == 2)

        session.discardFinding(id: first)
        #expect(session.hasUnfiledFindings)
        #expect(session.unfiledFindingCount == 1)

        session.discardFinding(id: second)
        #expect(!session.hasUnfiledFindings)
        #expect(session.unfiledFindingCount == 0)
    }

    @Test("an interrupted filing still counts as unfiled work; file-all clears the predicate")
    func unfiledFindingsAcrossTheFilingLadder() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Solo"))

        // The network dies right after issue creation: the item freezes
        // mid-ladder — no longer editable, not yet filed.
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: Self.createdIssue421)
        transport.enqueue(error: URLError(.timedOut))

        let interrupted = await core.fileAll(in: session)

        try #require(interrupted.failure != nil)
        try #require(!interrupted.session.tray[0].isEditable)
        // Frozen is not filed: the issue exists but carries neither
        // attachments nor tag — still unfiled work worth guarding.
        #expect(interrupted.session.hasUnfiledFindings)
        #expect(interrupted.session.unfiledFindingCount == 1)

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)

        let filed = await core.fileAll(in: interrupted.session)

        try #require(filed.failure == nil)
        #expect(!filed.session.hasUnfiledFindings)
        #expect(filed.session.unfiledFindingCount == 0)
    }

    // MARK: - File-all

    @Test("file-all creates exactly one issue per remaining Finding, in tray order, and lists every link")
    func fileAllHappyPath() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Toolbar icon is misaligned"))
        let dropped = session.addFinding(IssueFilingTests.finding(summary: "Not a real problem"))
        session.addFinding(IssueFilingTests.finding(summary: "Label truncates"))
        session.discardFinding(id: dropped)

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: Self.createdIssue421)
        Self.enqueueLadder(on: transport, created: Self.createdIssue422)

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure == nil)
        #expect(outcome.session.filedIssues == [Self.filedIssue("RM-421"), Self.filedIssue("RM-422")])
        #expect(outcome.session.tray.map(\.filedIssue) == [Self.filedIssue("RM-421"), Self.filedIssue("RM-422")])

        // One tag lookup for the whole run, then create → attach → tag per
        // Finding, in tray order.
        let urls = transport.sentRequests.dropFirst(2).map(\.url?.absoluteString)
        #expect(Array(urls) == [
            "\(Self.base)/api/tags?fields=id,name&query=design-review&$top=100",
            "\(Self.base)/api/issues?fields=id,idReadable",
            "\(Self.base)/api/issues/3-505/attachments?fields=id,name",
            "\(Self.base)/api/issues/3-505/tags?fields=id,name",
            "\(Self.base)/api/issues?fields=id,idReadable",
            "\(Self.base)/api/issues/3-506/attachments?fields=id,name",
            "\(Self.base)/api/issues/3-506/tags?fields=id,name",
        ])
        // Each created issue carries its own Finding's summary — the
        // discarded one never files.
        let creationBodies = transport.sentRequests
            .filter { $0.url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable" }
            .map { String(decoding: $0.httpBody ?? Data(), as: UTF8.self) }
        #expect(creationBodies.count == 2)
        #expect(creationBodies[0].contains(#""summary":"Toolbar icon is misaligned""#))
        #expect(creationBodies[1].contains(#""summary":"Label truncates""#))

        // Filed items are history: edits and discards are refused.
        var after = outcome.session
        after.updateFinding(id: after.tray[0].id) { $0.summary = "Too late" }
        after.discardFinding(id: after.tray[0].id)
        #expect(after == outcome.session)
    }

    @Test("a transport failure between Findings keeps every mark; the rest stay editable and retry files only the remainder")
    func partialFailureBetweenFindings() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "First"))
        session.addFinding(IssueFilingTests.finding(summary: "Second"))
        session.addFinding(IssueFilingTests.finding(summary: "Third"))

        // The network dies on the second Finding's creation request.
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: Self.createdIssue421)
        transport.enqueue(error: URLError(.networkConnectionLost))

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure is URLError)
        #expect(outcome.session.tray[0].filedIssue == Self.filedIssue("RM-421"))
        #expect(outcome.session.tray[1].isEditable)
        #expect(outcome.session.tray[2].isEditable)
        // connect (2) + tag lookup + first ladder (3) + failed creation.
        #expect(transport.sentRequests.count == 7)

        // The still-editable second Finding is sharpened before retrying…
        var retried = outcome.session
        retried.updateFinding(id: retried.tray[1].id) { $0.summary = "Second — sharpened" }

        // …and the retry files only the remainder.
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        Self.enqueueLadder(on: transport, created: Self.createdIssue422)
        Self.enqueueLadder(on: transport, created: Self.createdIssue423)

        let second = await core.fileAll(in: retried)

        #expect(second.failure == nil)
        #expect(second.session.filedIssues == [
            Self.filedIssue("RM-421"), Self.filedIssue("RM-422"), Self.filedIssue("RM-423"),
        ])
        // Exactly one creation per Finding across both runs — the first
        // Finding is never double-filed, and the retried creation carries
        // the sharpened summary.
        let creationBodies = transport.sentRequests
            .filter { $0.url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable" }
            .map { String(decoding: $0.httpBody ?? Data(), as: UTF8.self) }
        #expect(creationBodies.count == 4)  // incl. the failed attempt
        #expect(creationBodies.filter { $0.contains(#""summary":"First""#) }.count == 1)
        #expect(creationBodies.filter { $0.contains(#""summary":"Second — sharpened""#) }.count == 1)
        #expect(creationBodies.filter { $0.contains(#""summary":"Third""#) }.count == 1)
    }

    @Test("a failure after issue creation freezes the item and retry resumes at attachments — never a second issue")
    func resumesAfterIssueCreation() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Solo"))

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: Self.createdIssue421)
        transport.enqueue(error: URLError(.timedOut))

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure is URLError)
        let item = outcome.session.tray[0]
        #expect(item.filingProgress == .issueCreated(issueID: "3-505", idReadable: "RM-421"))
        #expect(item.filedIssue == nil)
        // The issue exists server-side, so the item froze: an edit now
        // would diverge from what RM-421 already says.
        #expect(!item.isEditable)
        var frozen = outcome.session
        frozen.updateFinding(id: item.id) { $0.summary = "Diverged" }
        frozen.discardFinding(id: item.id)
        #expect(frozen == outcome.session)

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)

        let second = await core.fileAll(in: outcome.session)

        #expect(second.failure == nil)
        #expect(second.session.filedIssues == [Self.filedIssue("RM-421")])
        let urls = transport.sentRequests.dropFirst(2).map(\.url?.absoluteString)
        #expect(Array(urls) == [
            "\(Self.base)/api/tags?fields=id,name&query=design-review&$top=100",
            "\(Self.base)/api/issues?fields=id,idReadable",
            "\(Self.base)/api/issues/3-505/attachments?fields=id,name",  // failed
            "\(Self.base)/api/tags?fields=id,name&query=design-review&$top=100",
            "\(Self.base)/api/issues/3-505/attachments?fields=id,name",
            "\(Self.base)/api/issues/3-505/tags?fields=id,name",
        ])
    }

    @Test("a failure at tag application resumes at the tag alone — attachments are never re-uploaded")
    func resumesAtTagApplication() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Solo"))

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: Self.createdIssue421)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(error: URLError(.networkConnectionLost))

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure is URLError)
        #expect(outcome.session.tray[0].filingProgress
            == .attachmentsUploaded(issueID: "3-505", idReadable: "RM-421"))

        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)

        let second = await core.fileAll(in: outcome.session)

        #expect(second.failure == nil)
        #expect(second.session.filedIssues == [Self.filedIssue("RM-421")])
        let urls = transport.sentRequests.dropFirst(2).map(\.url?.absoluteString)
        #expect(Array(urls) == [
            "\(Self.base)/api/tags?fields=id,name&query=design-review&$top=100",
            "\(Self.base)/api/issues?fields=id,idReadable",
            "\(Self.base)/api/issues/3-505/attachments?fields=id,name",
            "\(Self.base)/api/issues/3-505/tags?fields=id,name",  // failed
            "\(Self.base)/api/tags?fields=id,name&query=design-review&$top=100",
            "\(Self.base)/api/issues/3-505/tags?fields=id,name",
        ])
    }

    // MARK: - Pre-flight

    @Test("a summary-less Finding stops file-all before the first request — never a half-filed tray")
    func summaryPreflight() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding(summary: "Fine"))
        session.addFinding(IssueFilingTests.finding(summary: "  \n"))

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure as? YouTrackError == .summaryRequired)
        #expect(outcome.session == session)
        #expect(outcome.session.tray.allSatisfy { $0.isEditable })
        // Nothing beyond the two connect requests reached the network.
        #expect(transport.sentRequests.count == 2)
    }

    @Test("file-all before connecting fails actionably with the tray intact")
    func fileAllNotConnected() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )
        var session = IssueFilingTests.session
        session.addFinding(IssueFilingTests.finding())

        let outcome = await core.fileAll(in: session)

        #expect(outcome.failure as? YouTrackError == .notConnected)
        #expect(outcome.session == session)
        #expect(transport.sentRequests.isEmpty)
    }

    @Test("file-all with nothing left to file touches nothing")
    func fileAllNothingRemaining() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)

        let outcome = await core.fileAll(in: IssueFilingTests.session)

        #expect(outcome.failure == nil)
        #expect(outcome.session == IssueFilingTests.session)
        #expect(transport.sentRequests.count == 2)
    }
}
