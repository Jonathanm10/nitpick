import Foundation
import NitpickCore
import Testing

@Suite("Design Snapshot persistence")
struct DesignSnapshotPersistenceTests {
    let workspace: URL
    let core: AppCore
    let original: Data
    let replacement: Data

    init() throws {
        workspace = try Fixtures.makeTemporaryDirectory()
        core = DurabilityTests.relaunchedCore(workspace: workspace)
        original = try ImageFixtures.solidPNG(width: 80, height: 60)
        replacement = try ImageFixtures.solidPNG(width: 120, height: 90, white: 0.4)
    }

    private var openSession: URL { workspace.appendingPathComponent("open-session") }

    private func snapshotFiles(in findingID: UUID) throws -> [URL] {
        try FileManager.default.contentsOfDirectory(
            at: openSession.appendingPathComponent("design-snapshots/\(findingID.uuidString)"),
            includingPropertiesForKeys: nil
        )
    }

    private func sessionWithSnapshot() throws -> (ReviewSession, findingID: UUID, snapshotID: UUID) {
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())
        let snapshotID = try session.addDesignSnapshot(
            to: findingID, name: "button.png", mediaType: .png, data: original
        )
        return (session, findingID, snapshotID)
    }

    @Test("a Replace persists the new bytes, a relaunch reads them, and the old file is pruned")
    func replaceSurvivesRelaunch() throws {
        var (session, findingID, snapshotID) = try sessionWithSnapshot()
        try core.saveOpenSession(session)

        try session.replaceDesignSnapshot(snapshotID, in: findingID, mediaType: .png, data: replacement)
        try core.saveOpenSession(session)

        let resumed = try #require(try DurabilityTests.relaunchedCore(workspace: workspace).loadOpenSession())
        let snapshot = try #require(resumed.tray[0].finding.designSnapshots.first)
        #expect(snapshot.id == snapshotID)
        #expect(snapshot.name == "button.png")
        #expect(snapshot.data == replacement)
        #expect(try snapshotFiles(in: findingID).count == 1)
    }

    @Test("a crash between the new snapshot file and the manifest resumes the last saved state with every named file on disk")
    func crashBeforeManifestLeavesNoDanglingName() throws {
        var (session, findingID, snapshotID) = try sessionWithSnapshot()
        try core.saveOpenSession(session)
        try session.replaceDesignSnapshot(snapshotID, in: findingID, mediaType: .png, data: replacement)

        // A read-only slot lets the sidecar writes below it land but fails
        // the manifest write, which is where a crash would cut the save.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: openSession.path)
        #expect(throws: (any Error).self) { try core.saveOpenSession(session) }
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: openSession.path)
        #expect(try snapshotFiles(in: findingID).count == 2)

        let relaunched = DurabilityTests.relaunchedCore(workspace: workspace)
        let resumed = try #require(try relaunched.loadOpenSession())
        #expect(resumed.tray[0].finding.designSnapshots.map(\.data) == [original])

        try relaunched.saveOpenSession(session)
        let healed = try #require(try relaunched.loadOpenSession())
        #expect(healed.tray[0].finding.designSnapshots.map(\.data) == [replacement])
        #expect(try snapshotFiles(in: findingID).count == 1)
    }

    @Test("a text edit leaves the Design Snapshot files untouched")
    func textEditDoesNotRewriteSnapshots() throws {
        var (session, findingID, _) = try sessionWithSnapshot()
        try core.saveOpenSession(session)
        let file = try #require(try snapshotFiles(in: findingID).first)
        let before = try FileManager.default.attributesOfItem(atPath: file.path)[.systemFileNumber] as? Int

        session.updateFinding(id: findingID) { $0.summary = "Typed" }
        try core.saveOpenSession(session)

        let after = try FileManager.default.attributesOfItem(atPath: file.path)[.systemFileNumber] as? Int
        #expect(before != nil)
        #expect(after == before)
        #expect(try core.loadOpenSession()?.tray[0].finding.summary == "Typed")
    }

    @Test("a manifest written before data versions resumes its snapshots, and a later Replace still persists")
    func preDataVersionManifestLoads() throws {
        var (session, findingID, snapshotID) = try sessionWithSnapshot()
        try core.saveOpenSession(session)

        let manifest = openSession.appendingPathComponent("session.json")
        var stored = try #require(
            JSONSerialization.jsonObject(with: try Data(contentsOf: manifest)) as? [String: Any]
        )
        let tray = try #require(stored["tray"] as? [[String: Any]])
        stored["tray"] = tray.map { item -> [String: Any] in
            var item = item
            let snapshots = item["designSnapshots"] as? [[String: Any]] ?? []
            item["designSnapshots"] = snapshots.map { $0.filter { $0.key != "dataVersion" } }
            return item
        }
        try JSONSerialization.data(withJSONObject: stored).write(to: manifest)

        let resumed = try #require(try core.loadOpenSession())
        #expect(resumed.tray[0].finding.designSnapshots.map(\.data) == [original])

        session = resumed
        try session.replaceDesignSnapshot(snapshotID, in: findingID, mediaType: .png, data: replacement)
        try core.saveOpenSession(session)
        #expect(try core.loadOpenSession()?.tray[0].finding.designSnapshots.map(\.data) == [replacement])
    }
}
