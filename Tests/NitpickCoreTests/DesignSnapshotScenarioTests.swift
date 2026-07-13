import Foundation
import NitpickCore
import Testing

@Suite("Design Snapshots")
struct DesignSnapshotScenarioTests {
    @Test("one PNG survives relaunch, files separately, and leaves no local copy in History")
    func onePNGTracerBullet() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = try await DurabilityTests.connectedCore(
            transport: transport,
            workspace: workspace,
            credentials: credentials
        )
        let png = try ImageFixtures.solidPNG(width: 80, height: 60)
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())

        let snapshotID = try session.addDesignSnapshot(
            to: findingID,
            name: "button-spec.png",
            mediaType: .png,
            data: png
        )
        try core.saveOpenSession(session)

        let relaunched = DurabilityTests.relaunchedCore(
            workspace: workspace,
            transport: transport,
            credentials: credentials
        )
        let resumed = try #require(try relaunched.loadOpenSession())
        let snapshot = try #require(resumed.tray[0].finding.designSnapshots.first)
        #expect(snapshot.id == snapshotID)
        #expect(snapshot.name == "button-spec.png")
        #expect(snapshot.mediaType == .png)
        #expect(snapshot.data == png)
        #expect(resumed.metadataBlock(for: resumed.tray[0].finding) == session.metadataBlock(for: session.tray[0].finding))

        SessionTrayScenarioTests.enqueueTagLookups(on: transport)
        transport.enqueue(json: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(json: #"[{"id":"134-31","name":"annotated.png"},{"id":"134-32","name":"original.png"},{"id":"134-33","name":"button-spec.png"}]"#)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let outcome = await relaunched.fileAll(in: resumed)
        #expect(outcome.failure == nil)

        let creationBody = transport.sentRequests[4].httpBody.map { String(decoding: $0, as: UTF8.self) }
        #expect(creationBody == IssueFilingTests.expectedIssueJSON)

        let attach = transport.sentRequests[5]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == IssueFilingTests.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: IssueFilingTests.pngBytes),
            (fileName: "original.png", data: IssueFilingTests.pngBytes),
            (fileName: "button-spec.png", data: png),
        ]))

        #expect(try relaunched.loadOpenSession() == nil)
        #expect(try relaunched.sessionHistory().first?.findings.first?.issue.idReadable == "RM-421")
        let localSnapshotDirectory = workspace.appendingPathComponent("open-session/design-snapshots")
        #expect(!FileManager.default.fileExists(atPath: localSnapshotDirectory.path))
    }

    @Test("multiple Findings keep independent snapshots through rename, replace, removal, and relaunch")
    func managesSnapshotsPerFinding() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = DurabilityTests.relaunchedCore(workspace: workspace)
        let firstPNG = try ImageFixtures.solidPNG(width: 80, height: 60)
        let replacementPNG = try ImageFixtures.solidPNG(width: 120, height: 90)
        let secondPNG = try ImageFixtures.solidPNG(width: 40, height: 30)
        var session = IssueFilingTests.session
        let firstFinding = session.addFinding(IssueFilingTests.finding(summary: "First"))
        let secondFinding = session.addFinding(IssueFilingTests.finding(summary: "Second"))

        let kept = try session.addDesignSnapshot(
            to: firstFinding,
            name: "button.png",
            mediaType: .png,
            data: firstPNG
        )
        let removed = try session.addDesignSnapshot(
            to: firstFinding,
            name: "wrong.png",
            mediaType: .png,
            data: firstPNG
        )
        _ = try session.addDesignSnapshot(
            to: secondFinding,
            name: "other-finding.png",
            mediaType: .png,
            data: secondPNG
        )

        try session.renameDesignSnapshot(kept, in: firstFinding, to: "approved-button.png")
        try session.replaceDesignSnapshot(kept, in: firstFinding, mediaType: .png, data: replacementPNG)
        try session.removeDesignSnapshot(removed, from: firstFinding)
        try core.saveOpenSession(session)

        let resumed = try #require(try core.loadOpenSession())
        let firstSnapshots = resumed.tray[0].finding.designSnapshots
        #expect(firstSnapshots.count == 1)
        #expect(firstSnapshots[0].id == kept)
        #expect(firstSnapshots[0].name == "approved-button.png")
        #expect(firstSnapshots[0].mediaType == .png)
        #expect(firstSnapshots[0].data == replacementPNG)
        #expect(resumed.tray[1].finding.designSnapshots.map(\.name) == ["other-finding.png"])
    }

    @Test("rename and replacement keep attachment extensions truthful")
    func keepsExtensionsTruthful() throws {
        let png = try ImageFixtures.solidPNG(width: 20, height: 20)
        let jpeg = try ImageFixtures.solidJPEG(width: 20, height: 20)
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())
        let snapshotID = try session.addDesignSnapshot(
            to: findingID,
            name: "button.png",
            mediaType: .png,
            data: png
        )

        try session.renameDesignSnapshot(snapshotID, in: findingID, to: "approved.jpg")
        #expect(session.tray[0].finding.designSnapshots[0].name == "approved.png")

        try session.replaceDesignSnapshot(snapshotID, in: findingID, mediaType: .jpeg, data: jpeg)
        #expect(session.tray[0].finding.designSnapshots[0].name == "approved.jpg")
        #expect(session.tray[0].finding.designSnapshots[0].mediaType == .jpeg)
    }

    @Test("duplicate snapshot names file deterministically without changing designer-facing names")
    func disambiguatesDuplicateAttachmentNames() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        let pngA = try ImageFixtures.solidPNG(width: 20, height: 20)
        let pngB = try ImageFixtures.solidPNG(width: 30, height: 30)
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())
        _ = try session.addDesignSnapshot(to: findingID, name: "spec.png", mediaType: .png, data: pngA)
        _ = try session.addDesignSnapshot(to: findingID, name: "spec.png", mediaType: .png, data: pngB)

        SessionTrayScenarioTests.enqueueTagLookups(on: transport)
        transport.enqueue(json: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(json: #"[{"id":"1","name":"annotated.png"},{"id":"2","name":"original.png"},{"id":"3","name":"spec.png"},{"id":"4","name":"spec (2).png"}]"#)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        let outcome = await core.fileAll(in: session)
        #expect(outcome.failure == nil)
        #expect(session.tray[0].finding.designSnapshots.map(\.name) == ["spec.png", "spec.png"])

        let attach = transport.sentRequests[5]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == IssueFilingTests.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: IssueFilingTests.pngBytes),
            (fileName: "original.png", data: IssueFilingTests.pngBytes),
            (fileName: "spec.png", data: pngA),
            (fileName: "spec (2).png", data: pngB),
        ]))
    }

    @Test("a mixed file batch accepts PNG and JPEG while rejected files never become durable")
    func validatesMixedFileBatch() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = DurabilityTests.relaunchedCore(workspace: workspace)
        let png = try ImageFixtures.solidPNG(width: 20, height: 20)
        let jpeg = try ImageFixtures.solidJPEG(width: 24, height: 18)
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())

        let result = try session.addDesignSnapshotFiles([
            DesignSnapshotFile(name: "layout.png", data: png),
            DesignSnapshotFile(name: "detail.jpeg", data: jpeg),
            DesignSnapshotFile(name: "notes.pdf", data: Data("not a PDF image".utf8)),
            DesignSnapshotFile(name: "broken.png", data: Data("not an image".utf8)),
        ], to: findingID)

        #expect(result.added.count == 2)
        #expect(result.rejected.map(\.name) == ["notes.pdf", "broken.png"])
        #expect(result.rejected.map(\.error) == [
            .unsupportedFileType(fileExtension: "pdf"),
            .unreadableImage,
        ])
        try core.saveOpenSession(session)

        let resumed = try #require(try core.loadOpenSession())
        #expect(resumed.tray[0].finding.designSnapshots.map(\.name) == ["layout.png", "detail.jpeg"])
        #expect(resumed.tray[0].finding.designSnapshots.map(\.mediaType) == [.png, .jpeg])
        #expect(resumed.tray[0].finding.designSnapshots.map(\.data) == [png, jpeg])
    }

    @Test("JPEG files retain their extension, media type, and bytes on the wire")
    func filesJPEGExactly() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        let jpeg = try ImageFixtures.solidJPEG(width: 24, height: 18)
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())
        _ = try session.addDesignSnapshotFiles([
            DesignSnapshotFile(name: "expected-state.jpeg", data: jpeg),
        ], to: findingID)

        SessionTrayScenarioTests.enqueueTagLookups(on: transport)
        transport.enqueue(json: SessionTrayScenarioTests.createdIssue421)
        transport.enqueue(json: #"[{"id":"1","name":"annotated.png"},{"id":"2","name":"original.png"},{"id":"3","name":"expected-state.jpeg"}]"#)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)

        _ = try await core.file(session.tray[0].finding, in: session)

        let attach = transport.sentRequests[5]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == IssueFilingTests.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: IssueFilingTests.pngBytes),
            (fileName: "original.png", data: IssueFilingTests.pngBytes),
            (fileName: "expected-state.jpeg", data: jpeg),
        ]))
    }
}
