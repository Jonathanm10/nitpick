import Foundation
import NitpickCore
import Testing

/// The metadata block is a machine contract (ADR-0004): the v2 verify pass
/// will parse these exact bytes out of filed issues, so every rendering is
/// pinned byte-for-byte. A change here is a versioned schema change.
@Suite("Metadata block golden")
struct MetadataBlockTests {
    static let session = ReviewSession(
        build: Build(
            identity: BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"),
            appBundleURL: URL(fileURLWithPath: "/tmp/ReviewMe.app", isDirectory: true)
        ),
        project: YouTrackProject(id: "0-12", shortName: "RM", name: "ReviewMe"),
        startedAt: Date(timeIntervalSince1970: 1_783_156_532)  // 2026-07-04T09:15:32Z
    )

    static func finding(
        accessibilitySettings: [String] = [],
        designReference: URL? = nil
    ) -> Finding {
        Finding(
            summary: "Button color is off",
            description: "The primary button is #FF0000, the design says #E64545.",
            screenshotPNG: Data([0x89, 0x50, 0x4E, 0x47]),
            deviceContext: DeviceContext(
                deviceModel: "iPhone 17 Pro",
                osName: "iOS 26.4",
                accessibilitySettings: accessibilitySettings
            ),
            designReference: designReference
        )
    }

    @Test("default Device Context, no Design Reference: both conditional lines are absent")
    func minimalBlock() {
        #expect(
            Self.session.metadataBlock(for: Self.finding()) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("non-default accessibility settings render one comma-joined line")
    func accessibilityLine() {
        let finding = Self.finding(accessibilitySettings: ["Dynamic Type XL", "Dark Mode"])
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Accessibility: Dynamic Type XL, Dark Mode
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("a Design Reference renders as a Design line")
    func designLine() {
        let finding = Self.finding(designReference: URL(string: "https://www.figma.com/file/abc123/ReviewMe")!)
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Design: https://www.figma.com/file/abc123/ReviewMe
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("both conditional lines present, in contract order")
    func fullBlock() {
        let finding = Self.finding(
            accessibilitySettings: ["Dynamic Type XL"],
            designReference: URL(string: "https://www.figma.com/file/abc123/ReviewMe")!
        )
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Accessibility: Dynamic Type XL
            Design: https://www.figma.com/file/abc123/ReviewMe
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }
}
