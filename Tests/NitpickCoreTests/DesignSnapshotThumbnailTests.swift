import CoreGraphics
import Foundation
import NitpickCore
import Testing

@Suite("Design Snapshot thumbnails")
struct DesignSnapshotThumbnailTests {
    let card = CGSize(width: 208, height: 144)

    private func snapshot(width: Int, height: Int, jpeg: Bool = false) throws -> (ReviewSession, UUID, DesignSnapshot) {
        var session = IssueFilingTests.session
        let findingID = session.addFinding(IssueFilingTests.finding())
        let data = jpeg
            ? try ImageFixtures.solidJPEG(width: width, height: height)
            : try ImageFixtures.solidPNG(width: width, height: height)
        try session.addDesignSnapshot(
            to: findingID, name: jpeg ? "spec.jpg" : "spec.png", mediaType: jpeg ? .jpeg : .png, data: data
        )
        return (session, findingID, session.tray[0].finding.designSnapshots[0])
    }

    @Test("a tall phone-sized snapshot downsamples to just cover the card", arguments: [false, true])
    func tallSnapshotCoversCard(jpeg: Bool) throws {
        let (_, _, snapshot) = try snapshot(width: 1206, height: 2622, jpeg: jpeg)

        let thumbnail = try #require(snapshot.thumbnail(filling: card))

        #expect(thumbnail.width >= 208 && thumbnail.width <= 210)
        #expect(thumbnail.height >= 144 && thumbnail.height < 2622)
    }

    @Test("a wide snapshot covers the card height instead")
    func wideSnapshotCoversCard() throws {
        let (_, _, snapshot) = try snapshot(width: 2000, height: 500)

        let thumbnail = try #require(snapshot.thumbnail(filling: card))

        #expect(thumbnail.height >= 144 && thumbnail.height <= 146)
        #expect(thumbnail.width >= 208)
    }

    @Test("Replace gives the snapshot new data under a new dataVersion; a rename keeps it")
    func dataVersionFollowsBytes() throws {
        var (session, findingID, original) = try snapshot(width: 80, height: 60)

        try session.renameDesignSnapshot(original.id, in: findingID, to: "renamed.png")
        #expect(session.tray[0].finding.designSnapshots[0].dataVersion == original.dataVersion)

        try session.replaceDesignSnapshot(
            original.id, in: findingID, mediaType: .png, data: try ImageFixtures.solidPNG(width: 300, height: 200)
        )
        let replaced = session.tray[0].finding.designSnapshots[0]
        #expect(replaced.id == original.id)
        #expect(replaced.dataVersion != original.dataVersion)
        #expect(replaced.thumbnail(filling: card)?.width == 216)
    }
}
