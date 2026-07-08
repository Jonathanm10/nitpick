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

    // MARK: - Session-level Design Reference (issue 09)

    static var sessionWithReference: ReviewSession {
        var session = Self.session
        session.designReference = URL(string: "https://www.figma.com/file/sess42/ReviewMe")!
        return session
    }

    @Test("a session-level Design Reference renders on every Finding without its own")
    func sessionLevelDesignLine() {
        #expect(
            Self.sessionWithReference.metadataBlock(for: Self.finding()) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Design: https://www.figma.com/file/sess42/ReviewMe
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("a Finding-level Design Reference overrides the session-level one")
    func findingOverridesSession() {
        let finding = Self.finding(designReference: URL(string: "https://www.figma.com/file/abc123/ReviewMe")!)
        #expect(
            Self.sessionWithReference.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Design: https://www.figma.com/file/abc123/ReviewMe
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    // MARK: - The Accessibility line fed by observed Device Settings (ADR-0009)

    static let device = SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)

    @Test("default Device Settings stamp no Accessibility line")
    func defaultSettingsStampNothing() {
        var finding = Self.finding()
        finding.deviceContext = DeviceContext(device: Self.device, settings: DeviceSettings())
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("non-default Device Settings render Dynamic Type then Dark Mode")
    func nonDefaultSettingsStamp() {
        var finding = Self.finding()
        finding.deviceContext = DeviceContext(
            device: Self.device,
            settings: DeviceSettings(dynamicTypeSize: .accessibilityLarge, appearance: .dark)
        )
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Accessibility: Dynamic Type AX2, Dark Mode
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("a non-default Dynamic Type size alone renders without Dark Mode")
    func dynamicTypeAlone() {
        var finding = Self.finding()
        finding.deviceContext = DeviceContext(
            device: Self.device,
            settings: DeviceSettings(dynamicTypeSize: .extraLarge)
        )
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Accessibility: Dynamic Type XL
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("Increase Contrast renders after Dynamic Type and Dark Mode")
    func increaseContrastStamp() {
        var finding = Self.finding()
        finding.deviceContext = DeviceContext(
            device: Self.device,
            settings: DeviceSettings(dynamicTypeSize: .accessibilityLarge, appearance: .dark, increaseContrast: true)
        )
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Accessibility: Dynamic Type AX2, Dark Mode, Increase Contrast
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    @Test("Increase Contrast alone renders without Dynamic Type or Dark Mode")
    func increaseContrastAlone() {
        var finding = Self.finding()
        finding.deviceContext = DeviceContext(device: Self.device, settings: DeviceSettings(increaseContrast: true))
        #expect(
            Self.session.metadataBlock(for: finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Accessibility: Increase Contrast
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }

    /// The metadata contract's Dynamic Type vocabulary, pinned size by
    /// size: designers read these off the issue, and the v2 verify pass
    /// parses them back out.
    @Test("every Dynamic Type size has a pinned stamp name")
    func dynamicTypeStampNames() {
        let names = DeviceSettings.DynamicTypeSize.allCases.map(\.displayName)
        #expect(names == ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "AX1", "AX2", "AX3", "AX4", "AX5"])
    }
}
