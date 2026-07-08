import Foundation
import NitpickCore
import Testing

/// Accessibility is observed, not owned (ADR-0009): nitpick reads the
/// simulator's live accessibility state at capture time and stamps it,
/// `launch` touches no accessibility setting, and a mid-session device
/// switch relaunches the same Build while each Finding carries the state
/// read at its own capture moment.
@Suite("Device Context observation and switching")
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

    // MARK: - Observing the live accessibility state

    @Test("observedSettings issues the three no-argument ui reads and parses their output")
    func observedSettingsReadsAndParses() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("accessibility-large\n".utf8)))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("dark\n".utf8)))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("enabled\n".utf8)))

        let settings = try await core.observedSettings(of: iPhone)

        #expect(settings == DeviceSettings(dynamicTypeSize: .accessibilityLarge, appearance: .dark, increaseContrast: true))
        let xcrun = "/usr/bin/xcrun"
        #expect(runner.executedCommands == [
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "content_size"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "appearance"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "increase_contrast"]),
        ])
    }

    @Test("unsupported, unknown, and unparseable reads each map to the dimension's default")
    func observedSettingsMapsUnreadableToDefault() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("unsupported\n".utf8)))  // content_size
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("unknown\n".utf8)))       // appearance
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("wobble\n".utf8)))        // increase_contrast

        let settings = try await core.observedSettings(of: iPhone)

        #expect(settings == DeviceSettings())
        // Everything default: the composed Device Context carries no
        // Accessibility line, so no garbage token can reach a filed Issue.
        #expect(DeviceContext(device: iPhone, settings: settings).accessibilitySettings.isEmpty)
    }

    @Test("an unreadable dimension defaults independently — its valid siblings are still stamped")
    func observedSettingsDefaultsPerDimension() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("extra-large\n".utf8)))  // content_size, valid
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("unsupported\n".utf8)))  // appearance, unreadable
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("enabled\n".utf8)))       // increase_contrast, valid

        let settings = try await core.observedSettings(of: iPhone)

        // Only appearance falls back to its default; the readable dimensions stand.
        #expect(settings == DeviceSettings(dynamicTypeSize: .extraLarge, appearance: .default, increaseContrast: true))
    }

    // MARK: - The whole matrix, mid-session

    @Test("a mid-session switch relaunches the Build without touching accessibility; each Finding carries the state observed at its capture")
    func deviceSwitchScenario() async throws {
        var session = ReviewSession(
            build: build,
            project: YouTrackProject(id: "0-12", shortName: "RM", name: "Review Me"),
            startedAt: Date(timeIntervalSince1970: 1_783_156_532)  // 2026-07-04T09:15:32Z
        )
        let capturePath = workspace.appendingPathComponent("captures/capture.png")
        let xcrun = "/usr/bin/xcrun"

        // Reviewing on the iPhone: the capture reads back default
        // accessibility, so the Finding carries no Accessibility line.
        let iPhonePNG = Data([0x89, 0x50, 0x4E, 0x47, 0x01])
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data(Fixtures.deviceListJSON(udid: iPhone.udid, name: iPhone.name, state: "Booted").utf8)
        ))
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in try iPhonePNG.write(to: capturePath) }
        let iPhoneScreenshot = try await core.captureScreen(of: iPhone)
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("large\n".utf8)))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("light\n".utf8)))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("disabled\n".utf8)))
        session.addFinding(Finding(
            summary: "Toolbar icons misaligned", description: "",
            screenshotPNG: iPhoneScreenshot,
            deviceContext: DeviceContext(device: iPhone, settings: try await core.observedSettings(of: iPhone))
        ))

        // The designer switches to the iPad — the same Build relaunches, no
        // session setup redone and no accessibility command issued…
        for _ in 0..<5 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        try await core.launch(build, on: iPad)

        // …then, having bumped Dynamic Type, dark mode, and Increase Contrast
        // in the simulator, captures again — the read-back stamps all three.
        let iPadPNG = Data([0x89, 0x50, 0x4E, 0x47, 0x02])
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data(Fixtures.deviceListJSON(udid: iPad.udid, name: iPad.name, state: "Booted").utf8)
        ))
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in try iPadPNG.write(to: capturePath) }
        let iPadScreenshot = try await core.captureScreen(of: iPad)
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("accessibility-large\n".utf8)))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("dark\n".utf8)))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("enabled\n".utf8)))
        session.addFinding(Finding(
            summary: "Sidebar overlaps content", description: "",
            screenshotPNG: iPadScreenshot,
            deviceContext: DeviceContext(device: iPad, settings: try await core.observedSettings(of: iPad))
        ))

        // The exact wire story: each capture's booted re-check + screenshot +
        // three no-argument accessibility reads, and the switch's relaunch —
        // with no content_size / appearance set command anywhere.
        let listCommand = SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "list", "devices", "--json"])
        #expect(runner.executedCommands == [
            listCommand,
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "io", "AAAA-1111", "screenshot", "--type=png", capturePath.path]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "content_size"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "appearance"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "increase_contrast"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "boot", "BBBB-2222"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "bootstatus", "BBBB-2222", "-b"]),
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", "Simulator"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "install", "BBBB-2222", build.appBundleURL.path]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "launch", "BBBB-2222", "ch.liip.reviewme"]),
            listCommand,
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "io", "BBBB-2222", "screenshot", "--type=png", capturePath.path]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "BBBB-2222", "content_size"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "BBBB-2222", "appearance"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "BBBB-2222", "increase_contrast"]),
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
            Accessibility: Dynamic Type AX2, Dark Mode, Increase Contrast
            Filed with nitpick — session 2026-07-04T09:15:32Z
            """
        )
    }
}
