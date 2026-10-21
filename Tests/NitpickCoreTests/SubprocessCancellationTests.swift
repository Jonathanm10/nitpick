import Foundation
import NitpickCore
import Testing

@Suite("Cancelling a running subprocess")
struct SubprocessCancellationTests {
    let marker: URL

    init() throws {
        marker = try Fixtures.makeTemporaryDirectory().appendingPathComponent("running")
    }

    private func cancelOnceRunning(_ command: SubprocessCommand) async throws -> (error: (any Error)?, elapsed: Duration) {
        let task = Task { try await ProcessSubprocessRunner().run(command) }
        try await Fixtures.waitForFiles([marker])
        let clock = ContinuousClock()
        let start = clock.now
        task.cancel()
        let result = await task.result
        if case .failure(let error) = result { return (error, clock.now - start) }
        return (nil, clock.now - start)
    }

    @Test("a run left alone returns its exit code and both outputs in full")
    func uncancelledRunDrainsBothPipes() async throws {
        let script = "head -c 200000 /dev/zero | tr '\\0' a; printf failed >&2; exit 3"
        let result = try await ProcessSubprocessRunner().run(
            SubprocessCommand(executablePath: "/bin/sh", arguments: ["-c", script])
        )

        #expect(result.exitCode == 3)
        #expect(result.standardOutput == Data(repeating: UInt8(ascii: "a"), count: 200_000))
        #expect(result.standardError == Data("failed".utf8))
    }

    @Test("a cancelled run terminates the process and returns at once")
    func cancelTerminates() async throws {
        let (error, elapsed) = try await cancelOnceRunning(.sleep(touching: marker))

        #expect(error is CancellationError)
        #expect(elapsed < .seconds(10))
    }

    @Test("a process that ignores SIGTERM is killed after the grace period")
    func cancelKillsAStubbornProcess() async throws {
        let (error, elapsed) = try await cancelOnceRunning(.sleep(touching: marker, ignoringSIGTERM: true))

        #expect(error is CancellationError)
        #expect(elapsed >= .seconds(2))
        #expect(elapsed < .seconds(10))
    }

    @Test("a cancelled run returns at once while a descendant of the exited process holds its output open")
    func cancelStopsWaitingOnPipes() async throws {
        let (error, elapsed) = try await cancelOnceRunning(.sleepHoldingOutput(touchingAfterExit: marker))

        #expect(error is CancellationError)
        #expect(elapsed < .seconds(10))
    }
}
