import Foundation
import NitpickCore
import Testing

/// The walking skeleton, end to end through the app core's public API:
/// ingest a zipped Build → pick a device → boot/install/launch → capture.
/// Asserts the exact subprocess command sequence the core emits.
@Suite("Walking skeleton scenario")
struct WalkingSkeletonScenarioTests {
    @Test("ingest → boot → install → launch → capture emits the exact command sequence")
    func wholeFlow() async throws {
        let temp = try Fixtures.makeTemporaryDirectory()
        let workspace = temp.appendingPathComponent("workspace", isDirectory: true)
        let runner = FakeSubprocessRunner()
        let core = AppCore(environment: .fake(subprocess: runner), workspaceDirectory: workspace)

        // A CI-produced zipped Build lands in Downloads…
        let zipURL = temp.appendingPathComponent("ReviewMe-421.zip")
        try Data().write(to: zipURL)
        let extractionDirectory = workspace.appendingPathComponent("ingest/ReviewMe-421", isDirectory: true)
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try Fixtures.writeAppBundle(
                named: "ReviewMe.app", in: extractionDirectory, infoPlist: Fixtures.simulatorInfoPlist()
            )
        }

        // …the designer drags it in…
        let build = try await core.ingestBuild(at: zipURL)
        #expect(build.identity == BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"))

        // …picks a device…
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data(SimulatorDeviceTests.deviceListJSON.utf8)))
        let devices = try await core.simulatorDevices()
        let device = try #require(devices.first { $0.name == "iPhone 17 Pro" })

        // …starts the review (device happens to be booted already: exit 149)…
        runner.enqueue(SubprocessResult(exitCode: 149))
        for _ in 0..<6 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        try await core.launch(build, on: device)

        // …and captures the screen.
        let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF])
        let capturePath = workspace.appendingPathComponent("captures/capture.png").path
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try pngBytes.write(to: URL(fileURLWithPath: capturePath))
        }
        let captured = try await core.captureScreen(of: device)
        #expect(captured == pngBytes)

        let xcrun = "/usr/bin/xcrun"
        let appPath = extractionDirectory.appendingPathComponent("ReviewMe.app").path
        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: "/usr/bin/tar",
                arguments: ["-x", "-f", zipURL.path, "-C", extractionDirectory.path]
            ),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "list", "devices", "--json"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "boot", "AAAA-1111"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "bootstatus", "AAAA-1111", "-b"]),
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", "Simulator"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "content_size", "large"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "ui", "AAAA-1111", "appearance", "light"]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "install", "AAAA-1111", appPath]),
            SubprocessCommand(executablePath: xcrun, arguments: ["simctl", "launch", "AAAA-1111", "ch.liip.reviewme"]),
            SubprocessCommand(
                executablePath: xcrun,
                arguments: ["simctl", "io", "AAAA-1111", "screenshot", "--type=png", capturePath]
            ),
        ])
    }
}
