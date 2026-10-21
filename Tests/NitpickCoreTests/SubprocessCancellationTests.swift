import Foundation
import NitpickCore
import Testing

@Suite("Cancelling a running subprocess")
struct SubprocessCancellationTests {
    let marker: URL

    init() throws {
        marker = try Fixtures.makeTemporaryDirectory().appendingPathComponent("running")
    }

    private func cancelOnceRunning(ignoringSIGTERM: Bool = false) async throws -> (error: (any Error)?, elapsed: Duration) {
        let command = SubprocessCommand.sleep(touching: marker, ignoringSIGTERM: ignoringSIGTERM)
        let task = Task { try await ProcessSubprocessRunner().run(command) }
        try await Fixtures.waitForFiles([marker])
        let clock = ContinuousClock()
        let start = clock.now
        task.cancel()
        let result = await task.result
        if case .failure(let error) = result { return (error, clock.now - start) }
        return (nil, clock.now - start)
    }

    @Test("a cancelled run terminates the process and returns at once")
    func cancelTerminates() async throws {
        let (error, elapsed) = try await cancelOnceRunning()

        #expect(error is CancellationError)
        #expect(elapsed < .seconds(10))
    }

    @Test("a process that ignores SIGTERM is killed after the grace period")
    func cancelKillsAStubbornProcess() async throws {
        let (error, elapsed) = try await cancelOnceRunning(ignoringSIGTERM: true)

        #expect(error is CancellationError)
        #expect(elapsed >= .seconds(2))
        #expect(elapsed < .seconds(10))
    }
}
