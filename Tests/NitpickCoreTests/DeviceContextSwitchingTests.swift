import Foundation
import NitpickCore
import Testing

/// The size/accessibility matrix inside one Review Session (issue 06):
/// Dynamic Type and appearance are set from nitpick, a device switch
/// relaunches the same Build under the session's current Device Settings,
/// and every Finding is stamped with the Device Context in effect at its
/// capture moment.
@Suite("Device Context switching")
struct DeviceContextSwitchingTests {
    let workspace: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore
    let build: Build
    let iPhone = SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)
    let iPad = SimulatorDevice(udid: "BBBB-2222", name: "iPad Pro 13-inch (M4)", osName: "iOS 26.4", isBooted: false)

    init() throws {
        let temp = try Fixtures.makeTemporaryDirectory()
        workspace = temp.appendingPathComponent("workspace", isDirectory: true)
        core = AppCore(environment: .fake(subprocess: runner), workspaceDirectory: workspace)
        let appURL = try Fixtures.writeAppBundle(
            named: "ReviewMe.app", in: temp, infoPlist: Fixtures.simulatorInfoPlist()
        )
        build = Build(
            identity: BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"),
            appBundleURL: appURL
        )
    }

    // MARK: - Settings changes

    @Test("changing the Dynamic Type size emits exactly one content_size command")
    func dynamicTypeCommand() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0))

        try await core.setDynamicTypeSize(.accessibilityLarge, on: iPhone)

        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "ui", "AAAA-1111", "content_size", "accessibility-large"]
            )
        ])
    }

    @Test("changing the appearance emits exactly one appearance command")
    func appearanceCommand() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0))

        try await core.setAppearance(.dark, on: iPhone)

        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "ui", "AAAA-1111", "appearance", "dark"]
            )
        ])
    }

    @Test("a failed settings change surfaces the subprocess failure")
    func settingsFailure() async {
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("Invalid device: AAAA-1111".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.setAppearance(.dark, on: iPhone)
        }
    }

    // MARK: - The whole matrix, mid-session

    @Test("a mid-session switch relaunches the same Build under the session's settings; each Finding carries its capture-moment stamp")
    func deviceSwitchScenario() async throws {
        var session = ReviewSession(
            build: build,
            project: YouTrackProject(id: "0-12", shortName: "RM", name: "Review Me"),
            startedAt: Date(timeIntervalSince1970: 1_783_156_532)  // 2026-07-04T09:15:32Z
        )
        var settings = DeviceSettings()
        let capturePath = workspace.appendingPathComponent("captures/capture.png")

        // Reviewing on the iPhone under default settings: the first capture
        // is stamped with that Device Context.
        let iPhonePNG = Data([0x89, 0x50, 0x4E, 0x47, 0x01])
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in try iPhonePNG.write(to: capturePath) }
        session.addFinding(Finding(
            summary: "Toolbar icons misaligned", description: "",
            screenshotPNG: try await core.captureScreen(of: iPhone),
            deviceContext: DeviceContext(device: iPhone, settings: settings)
        ))

        // The designer bumps Dynamic Type and switches to dark…
        runner.enqueue(SubprocessResult(exitCode: 0))
        try await core.setDynamicTypeSize(.accessibilityLarge, on: iPhone)
        settings.dynamicTypeSize = .accessibilityLarge
        runner.enqueue(SubprocessResult(exitCode: 0))
        try await core.setAppearance(.dark, on: iPhone)
        settings.appearance = .dark

        // …switches to the iPad — the same Build relaunches under the
        // session's current settings, no session setup redone…
        for _ in 0..<7 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        try await core.launch(build, on: iPad, settings: settings)

        // …and captures again under the new Device Context.
        let iPadPNG = Data([0x89, 0x50, 0x4E, 0x47, 0x02])
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in try iPadPNG.write(to: capturePath) }
        session.addFinding(Finding(
            summary: "Sidebar overlaps content", description: "",
            screenshotPNG: try await core.captureScreen(of: iPad),
            deviceContext: DeviceContext(device: iPad, settings: settings)
        ))

        // The exact wire story: capture, two settings changes, the switch's
        // full relaunch under the session's settings, capture.
        let xcrun = "/usr/bin/xcrun"
        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: xcrun,
                arguments: ["simctl", "io", "AAAA-1111", "screenshot", "--type=png", capturePath.path]
            ),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "content_size", "accessibility-large"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "appearance", "dark"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "boot", "BBBB-2222"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "bootstatus", "BBBB-2222", "-b"]),
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", "Simulator"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "BBBB-2222", "content_size", "accessibility-large"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "BBBB-2222", "appearance", "dark"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "install", "BBBB-2222", build.appBundleURL.path]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "launch", "BBBB-2222", "ch.liip.reviewme"]),
            SubprocessCommand(
                executablePath: xcrun,
                arguments: ["simctl", "io", "BBBB-2222", "screenshot", "--type=png", capturePath.path]
            ),
        ])

        // The session survived the switch: both Findings in one tray,
        // stamped with different, correct Device Contexts.
        try #require(session.tray.count == 2)
        #expect(session.tray[0].finding.screenshotPNG == iPhonePNG)
        #expect(session.tray[1].finding.screenshotPNG == iPadPNG)
        #expect(
            session.metadataBlock(for: session.tray[0].finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPhone 17 Pro — iOS 26.4
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
        #expect(
            session.metadataBlock(for: session.tray[1].finding) == """
            ---
            App: ch.liip.reviewme 2.1.0 (421)
            Device: iPad Pro 13-inch (M4) — iOS 26.4
            Accessibility: Dynamic Type AX2, Dark Mode
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }
}
