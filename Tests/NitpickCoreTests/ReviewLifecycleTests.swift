import Foundation
import NitpickCore
import Testing

@Suite("Launching a Build on a simulator")
struct ReviewLifecycleTests {
    let temp: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore
    let build: Build
    let device = SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: false)

    init() throws {
        temp = try Fixtures.makeTemporaryDirectory()
        core = AppCore(
            environment: .fake(subprocess: runner),
            workspaceDirectory: temp.appendingPathComponent("workspace", isDirectory: true)
        )
        let appURL = try Fixtures.writeAppBundle(
            named: "ReviewMe.app", in: temp, infoPlist: Fixtures.simulatorInfoPlist()
        )
        build = Build(
            identity: BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"),
            appBundleURL: appURL
        )
    }

    private func expectedSequence(contentSize: String = "large", appearance: String = "light") -> [SubprocessCommand] {
        [
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "boot", "AAAA-1111"]),
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "bootstatus", "AAAA-1111", "-b"]),
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", "Simulator"]),
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "ui", "AAAA-1111", "content_size", contentSize]
            ),
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "ui", "AAAA-1111", "appearance", appearance]
            ),
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "install", "AAAA-1111", build.appBundleURL.path]
            ),
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "launch", "AAAA-1111", "ch.liip.reviewme"]
            ),
        ]
    }

    @Test("boots, waits for boot, opens Simulator, applies default Device Settings, installs, launches — in that order")
    func launchSequence() async throws {
        for _ in 0..<7 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        try await core.launch(build, on: device)

        #expect(runner.executedCommands == expectedSequence())
    }

    /// Applying the session's settings on every launch is what keeps the
    /// stamps trustworthy: a simulator left dark by an earlier run can
    /// never contradict a Finding's Accessibility line.
    @Test("launching under non-default Device Settings applies them before install")
    func launchWithSettings() async throws {
        for _ in 0..<7 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        try await core.launch(
            build,
            on: device,
            settings: DeviceSettings(dynamicTypeSize: .accessibilityMedium, appearance: .dark)
        )

        #expect(runner.executedCommands == expectedSequence(contentSize: "accessibility-medium", appearance: "dark"))
    }

    @Test("an already-booted device is not an error")
    func alreadyBooted() async throws {
        runner.enqueue(SubprocessResult(
            exitCode: 149,
            standardError: Data("Unable to boot device in current state: Booted".utf8)
        ))
        for _ in 0..<6 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        try await core.launch(build, on: device)

        #expect(runner.executedCommands == expectedSequence())
    }

    @Test("a real boot failure stops the sequence")
    func bootFailure() async throws {
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("Invalid device: AAAA-1111".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands == [expectedSequence()[0]])
    }

    @Test("an install failure surfaces and stops before launch")
    func installFailure() async throws {
        for _ in 0..<5 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        runner.enqueue(SubprocessResult(exitCode: 22, standardError: Data("Failed to install".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands == Array(expectedSequence().prefix(6)))
    }
}
