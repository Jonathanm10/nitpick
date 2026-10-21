import Foundation
import NitpickCore
import Synchronization
import Testing

/// Scripted stand-in for the subprocess seam. Responses are consumed in FIFO
/// order; a response enqueued `for:` a command answers only that command,
/// ahead of the queue, so concurrent steps get the right stub whatever
/// order they start in. Every executed command is recorded.
final class FakeSubprocessRunner: SubprocessRunner {
    struct Stub {
        var command: SubprocessCommand?
        var result: SubprocessResult
        var sideEffect: (@Sendable (SubprocessCommand) throws -> Void)?
    }

    struct NoStubbedResponse: Error {
        var command: SubprocessCommand
    }

    private struct State {
        var stubs: [Stub] = []
        var executed: [SubprocessCommand] = []
    }

    private let state = Mutex(State())

    func enqueue(
        _ result: SubprocessResult,
        for command: SubprocessCommand? = nil,
        sideEffect: (@Sendable (SubprocessCommand) throws -> Void)? = nil
    ) {
        state.withLock { $0.stubs.append(Stub(command: command, result: result, sideEffect: sideEffect)) }
    }

    var executedCommands: [SubprocessCommand] {
        state.withLock { $0.executed }
    }

    func run(_ command: SubprocessCommand) async throws -> SubprocessResult {
        try state.withLock { state in
            state.executed.append(command)
            guard let index = state.stubs.firstIndex(where: { $0.command == command })
                ?? state.stubs.firstIndex(where: { $0.command == nil })
            else { throw NoStubbedResponse(command: command) }
            let stub = state.stubs.remove(at: index)
            try stub.sideEffect?(command)
            return stub.result
        }
    }

    /// Expects the executed commands step by step: steps in order, the
    /// commands inside one step in any order, because they run
    /// concurrently.
    func expectExecuted(
        inSteps steps: [[SubprocessCommand]],
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        var remaining = executedCommands[...]
        #expect(remaining.count == steps.joined().count, sourceLocation: sourceLocation)
        for step in steps {
            #expect(Set(remaining.prefix(step.count)) == Set(step), sourceLocation: sourceLocation)
            remaining = remaining.dropFirst(step.count)
        }
    }
}

extension FakeSubprocessRunner {
    /// Scripts one successful capture: the device-list check reports the
    /// device booted, the screenshot writes `png`, and the three settings
    /// reads answer with `settings` (raw `simctl ui` values).
    func enqueueCapture(
        of device: SimulatorDevice,
        png: Data,
        at capturePath: URL,
        settings: (contentSize: String, appearance: String, increaseContrast: String) = ("large", "light", "disabled")
    ) {
        enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data(Fixtures.deviceListJSON(udid: device.udid, name: device.name, state: "Booted").utf8)
        ))
        enqueue(SubprocessResult(exitCode: 0), for: .screenshot(device, to: capturePath)) { _ in
            try png.write(to: capturePath)
        }
        for (option, value) in [
            ("content_size", settings.contentSize),
            ("appearance", settings.appearance),
            ("increase_contrast", settings.increaseContrast),
        ] {
            enqueue(
                SubprocessResult(exitCode: 0, standardOutput: Data("\(value)\n".utf8)),
                for: .uiRead(option, of: device)
            )
        }
    }
}

extension SubprocessCommand {
    static let deviceList = SubprocessCommand(
        executablePath: "/usr/bin/xcrun",
        arguments: ["simctl", "list", "devices", "--json"]
    )

    static func screenshot(_ device: SimulatorDevice, to path: URL) -> SubprocessCommand {
        SubprocessCommand(
            executablePath: "/usr/bin/xcrun",
            arguments: ["simctl", "io", device.udid, "screenshot", "--type=png", path.path]
        )
    }

    static func uiRead(_ option: String, of device: SimulatorDevice) -> SubprocessCommand {
        SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "ui", device.udid, option])
    }

    static func settingsReads(of device: SimulatorDevice) -> [SubprocessCommand] {
        ["content_size", "appearance", "increase_contrast"].map { uiRead($0, of: device) }
    }

    /// A live 30 s sleep that touches `marker` once it runs, so a test can
    /// cancel a process that has really started. `exec` keeps an ignored
    /// SIGTERM ignored in the sleep itself.
    static func sleep(touching marker: URL, ignoringSIGTERM: Bool = false) -> SubprocessCommand {
        let script = (ignoringSIGTERM ? "trap '' TERM; " : "") + "touch \"$1\"; exec /bin/sleep 30"
        return SubprocessCommand(executablePath: "/bin/sh", arguments: ["-c", script, "sh", marker.path])
    }

    /// The shell exits at once, leaving a background sleep that holds its
    /// stdout open. The sleep touches `marker` only once the shell is
    /// reaped, so the run is past the exit and waiting on its pipes.
    static func sleepHoldingOutput(touchingAfterExit marker: URL) -> SubprocessCommand {
        let script = #"(while kill -0 $$ 2>/dev/null; do /bin/sleep 0.05; done; touch "$1"; exec /bin/sleep 30) &"#
        return SubprocessCommand(executablePath: "/bin/sh", arguments: ["-c", script, "sh", marker.path])
    }
}

extension Fixtures {
    static func waitForFiles(_ files: [URL], timeout: Duration = .seconds(15)) async throws {
        let deadline = ContinuousClock.now + timeout
        while !files.allSatisfy({ FileManager.default.fileExists(atPath: $0.path) }) {
            guard ContinuousClock.now < deadline else { throw WaitTimedOut() }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    struct WaitTimedOut: Error {}
}

extension CoreEnvironment {
    /// Environment for scenario tests: scripted seams where the scenario
    /// needs them, everything else unimplemented.
    static func fake(
        subprocess: any SubprocessRunner = UnimplementedSubprocessRunner(),
        httpTransport: any HTTPTransport = UnimplementedHTTPTransport(),
        credentialStore: any CredentialStore = UnimplementedCredentialStore()
    ) -> CoreEnvironment {
        CoreEnvironment(
            subprocess: subprocess,
            httpTransport: httpTransport,
            credentialStore: credentialStore
        )
    }
}

/// Reaching the subprocess seam in a scenario that never scripted it is a
/// test bug, surfaced like the other unimplemented effects.
struct UnimplementedSubprocessRunner: SubprocessRunner {
    func run(_ command: SubprocessCommand) async throws -> SubprocessResult {
        throw UnimplementedEffect(name: "Subprocess runner")
    }
}
