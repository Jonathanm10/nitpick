import Foundation
import NitpickCore
import Synchronization

/// Scripted stand-in for the subprocess seam. Responses are consumed in FIFO
/// order; every executed command is recorded for exact-sequence assertions.
final class FakeSubprocessRunner: SubprocessRunner {
    struct Stub {
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
        sideEffect: (@Sendable (SubprocessCommand) throws -> Void)? = nil
    ) {
        state.withLock { $0.stubs.append(Stub(result: result, sideEffect: sideEffect)) }
    }

    var executedCommands: [SubprocessCommand] {
        state.withLock { $0.executed }
    }

    func run(_ command: SubprocessCommand) async throws -> SubprocessResult {
        try state.withLock { state in
            state.executed.append(command)
            guard !state.stubs.isEmpty else { throw NoStubbedResponse(command: command) }
            let stub = state.stubs.removeFirst()
            try stub.sideEffect?(command)
            return stub.result
        }
    }
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
