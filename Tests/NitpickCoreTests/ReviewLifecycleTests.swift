import Foundation
import NitpickCore
import Testing

@Suite("Launching a Build on a simulator")
struct ReviewLifecycleTests {
    let temp: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore
    let build: Build
    let xcode: Fixtures.FixtureXcode
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
        xcode = try Fixtures.writeXcode(in: temp, hostApp: .simulator)
    }

    private func expectedSequence(hostAppURL: URL) -> [SubprocessCommand] {
        [
            SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"]),
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "boot", "AAAA-1111"]),
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "bootstatus", "AAAA-1111", "-b"]),
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", hostAppURL.path]),
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

    private func enqueueXcodeSelect(_ fixture: Fixtures.FixtureXcode) {
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data("\(fixture.developerDirectory.path)\n".utf8)
        ))
    }

    @Test("boots, waits for boot, opens the host app by path, installs, launches — in that order")
    func launchSequence() async throws {
        let hostAppURL = try #require(xcode.hostAppURL)
        enqueueXcodeSelect(xcode)
        for _ in 0..<5 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        let host = try await core.launch(build, on: device)

        #expect(host.bundleIdentifier == "com.apple.iphonesimulator")
        #expect(host.bundleURL.path == hostAppURL.path)
        #expect(runner.executedCommands == expectedSequence(hostAppURL: hostAppURL))
    }

    @Test("opens DeviceHub.app by absolute path when the selected Xcode ships it")
    func launchOpensDeviceHub() async throws {
        let deviceHubXcode = try Fixtures.writeXcode(
            in: temp.appendingPathComponent("xcode27"), hostApp: .deviceHub
        )
        let hostAppURL = try #require(deviceHubXcode.hostAppURL)
        enqueueXcodeSelect(deviceHubXcode)
        for _ in 0..<5 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        let host = try await core.launch(build, on: device)

        #expect(host.bundleIdentifier == "com.apple.dt.Devices")
        #expect(host.displayName == "DeviceHub")
        #expect(runner.executedCommands == expectedSequence(hostAppURL: hostAppURL))
    }

    @Test("an already-booted device is not an error")
    func alreadyBooted() async throws {
        let hostAppURL = try #require(xcode.hostAppURL)
        enqueueXcodeSelect(xcode)
        runner.enqueue(SubprocessResult(
            exitCode: 149,
            standardError: Data("Unable to boot device in current state: Booted".utf8)
        ))
        for _ in 0..<4 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        try await core.launch(build, on: device)

        #expect(runner.executedCommands == expectedSequence(hostAppURL: hostAppURL))
    }

    @Test("a real boot failure stops the sequence")
    func bootFailure() async throws {
        let hostAppURL = try #require(xcode.hostAppURL)
        enqueueXcodeSelect(xcode)
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("Invalid device: AAAA-1111".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands == Array(expectedSequence(hostAppURL: hostAppURL).prefix(2)))
    }

    @Test("an install failure surfaces and stops before launch")
    func installFailure() async throws {
        let hostAppURL = try #require(xcode.hostAppURL)
        enqueueXcodeSelect(xcode)
        for _ in 0..<3 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        runner.enqueue(SubprocessResult(exitCode: 22, standardError: Data("Failed to install".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands == Array(expectedSequence(hostAppURL: hostAppURL).prefix(5)))
    }

    @Test("a missing host app fails before any boot, naming the paths searched")
    func hostAppNotFoundStopsBeforeBoot() async throws {
        let empty = try Fixtures.writeXcode(in: temp.appendingPathComponent("no-host"), hostApp: .none)
        enqueueXcodeSelect(empty)

        let error = try await #require(throws: SimulatorError.self) {
            try await core.launch(build, on: device)
        }
        guard case .hostAppNotFound(let directory, let searched) = error else {
            Issue.record("expected hostAppNotFound, got \(error)")
            return
        }
        #expect(directory == empty.developerDirectory.path)
        #expect(searched.contains { $0.hasSuffix("DeviceHub.app") })
        #expect(searched.contains { $0.hasSuffix("Simulator.app") })
        #expect(error.errorDescription?.contains(empty.developerDirectory.path) == true)
        #expect(runner.executedCommands == [
            SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"])
        ])
    }
}
