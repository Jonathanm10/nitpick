import Foundation
import NitpickCore
import Testing

@Suite("Cancelling a running subprocess")
struct SubprocessCancellationTests {
    let runner = ProcessSubprocessRunner()

    private func cancelWhileRunning(_ command: SubprocessCommand) async -> (error: (any Error)?, elapsed: Duration) {
        let clock = ContinuousClock()
        let start = clock.now
        let task = Task { try await runner.run(command) }
        try? await Task.sleep(for: .milliseconds(200))
        task.cancel()
        let result = await task.result
        if case .failure(let error) = result { return (error, clock.now - start) }
        return (nil, clock.now - start)
    }

    @Test("a cancelled run terminates the process and returns at once")
    func cancelTerminates() async {
        let (error, elapsed) = await cancelWhileRunning(
            SubprocessCommand(executablePath: "/bin/sleep", arguments: ["30"])
        )

        #expect(error is CancellationError)
        #expect(elapsed < .seconds(2))
    }

    @Test("a process that ignores SIGTERM is killed after the grace period")
    func cancelKillsAStubbornProcess() async {
        let (error, elapsed) = await cancelWhileRunning(
            SubprocessCommand(executablePath: "/bin/sh", arguments: ["-c", "trap '' TERM; exec /bin/sleep 30"])
        )

        #expect(error is CancellationError)
        #expect(elapsed >= .seconds(2))
        #expect(elapsed < .seconds(5))
    }
}
