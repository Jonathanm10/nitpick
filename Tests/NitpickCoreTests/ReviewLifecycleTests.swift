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

    private var expectedSequence: [SubprocessCommand] {
        [
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "boot", "AAAA-1111"]),
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "bootstatus", "AAAA-1111", "-b"]),
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", "Simulator"]),
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

    @Test("boots, waits for boot to finish, opens Simulator, installs, launches — in that order")
    func launchSequence() async throws {
        for _ in 0..<5 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        try await core.launch(build, on: device)

        #expect(runner.executedCommands == expectedSequence)
    }

    @Test("an already-booted device is not an error")
    func alreadyBooted() async throws {
        runner.enqueue(SubprocessResult(
            exitCode: 149,
            standardError: Data("Unable to boot device in current state: Booted".utf8)
        ))
        for _ in 0..<4 { runner.enqueue(SubprocessResult(exitCode: 0)) }

        try await core.launch(build, on: device)

        #expect(runner.executedCommands == expectedSequence)
    }

    @Test("a real boot failure stops the sequence")
    func bootFailure() async throws {
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("Invalid device: AAAA-1111".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands == [expectedSequence[0]])
    }

    @Test("an install failure surfaces and stops before launch")
    func installFailure() async throws {
        for _ in 0..<3 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        runner.enqueue(SubprocessResult(exitCode: 22, standardError: Data("Failed to install".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands == Array(expectedSequence.prefix(4)))
    }
}
