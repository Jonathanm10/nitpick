import Foundation
import NitpickCore
import Testing

@Suite("Capturing the simulator screen")
struct CaptureTests {
    let workspace: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore
    let device = SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)

    init() throws {
        workspace = try Fixtures.makeTemporaryDirectory()
            .appendingPathComponent("workspace", isDirectory: true)
        core = AppCore(environment: .fake(subprocess: runner), workspaceDirectory: workspace)
    }

    private var expectedCapturePath: String {
        workspace.appendingPathComponent("captures/capture.png").path
    }

    @Test("a capture runs simctl screenshot and returns the PNG bytes")
    func capture() async throws {
        let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03])
        let path = expectedCapturePath
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try pngBytes.write(to: URL(fileURLWithPath: path))
        }

        let captured = try await core.captureScreen(of: device)

        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "io", "AAAA-1111", "screenshot", "--type=png", path]
            )
        ])
        #expect(captured == pngBytes)
    }

    @Test("a screenshot failure surfaces as a subprocess failure")
    func screenshotFailure() async throws {
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("No devices are booted.".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.captureScreen(of: device)
        }
    }

    @Test("a screenshot that reports success but writes nothing is a clear error")
    func missingCaptureFile() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0))

        await #expect(throws: SimulatorError.captureUnreadable(path: expectedCapturePath)) {
            try await core.captureScreen(of: device)
        }
    }
}
