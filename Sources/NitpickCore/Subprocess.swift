import Foundation
import Synchronization

/// One out-of-process invocation: an absolute executable path plus arguments.
public struct SubprocessCommand: Hashable, Sendable {
    public var executablePath: String
    public var arguments: [String]

    public init(executablePath: String, arguments: [String]) {
        self.executablePath = executablePath
        self.arguments = arguments
    }
}

/// What a finished subprocess left behind.
public struct SubprocessResult: Equatable, Sendable {
    public var exitCode: Int32
    public var standardOutput: Data
    public var standardError: Data

    public init(exitCode: Int32, standardOutput: Data = Data(), standardError: Data = Data()) {
        self.exitCode = exitCode
        self.standardOutput = standardOutput
        self.standardError = standardError
    }
}

/// The subprocess effects seam. Implementations run the command to completion;
/// a non-zero exit is reported in the result, not thrown. Throwing is reserved
/// for failure to run the command at all (missing executable, spawn failure).
public protocol SubprocessRunner: Sendable {
    func run(_ command: SubprocessCommand) async throws -> SubprocessResult
}

/// A subprocess exited non-zero where the core required success.
public struct SubprocessFailure: Error, Equatable, LocalizedError {
    public var command: SubprocessCommand
    public var exitCode: Int32
    public var standardError: String

    public init(command: SubprocessCommand, exitCode: Int32, standardError: String) {
        self.command = command
        self.exitCode = exitCode
        self.standardError = standardError
    }

    public var errorDescription: String? {
        let commandLine = ([command.executablePath] + command.arguments).joined(separator: " ")
        var message = "Command failed (exit \(exitCode)): \(commandLine)"
        let trimmed = standardError.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            message += "\n\(trimmed)"
        }
        return message
    }
}

/// Live runner backed by Foundation.Process.
public struct ProcessSubprocessRunner: SubprocessRunner {
    public init() {}

    public func run(_ command: SubprocessCommand) async throws -> SubprocessResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command.executablePath)
        process.arguments = command.arguments

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = FileHandle.nullDevice

        // Drains accumulate concurrently so a chatty subprocess can't
        // deadlock against a full pipe buffer; they complete at EOF.
        let stdout = PipeDrain(stdoutPipe)
        let stderr = PipeDrain(stderrPipe)

        // The termination handler is installed before run() so a subprocess
        // that exits instantly can't slip past it. Cancellation stops the
        // process and the drains, so neither a stuck command nor a
        // descendant holding its pipes open keeps a caller that gave up.
        let launch = Mutex(Launch.pending)
        return try await withTaskCancellationHandler {
            let exitCode: Int32 = try await withCheckedThrowingContinuation { continuation in
                process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
                do {
                    try launch.withLock { state in
                        guard state == .pending else { throw CancellationError() }
                        try process.run()
                        state = .running
                    }
                } catch {
                    process.terminationHandler = nil
                    continuation.resume(throwing: error)
                }
            }
            let standardOutput = await stdout.drainToEnd()
            let standardError = await stderr.drainToEnd()
            try Task.checkCancellation()
            return SubprocessResult(exitCode: exitCode, standardOutput: standardOutput, standardError: standardError)
        } onCancel: {
            launch.withLock { state in
                if state == .running { Self.stop(process) }
                state = .cancelled
            }
            stdout.finish()
            stderr.finish()
        }
    }

    private enum Launch {
        case pending, running, cancelled
    }

    private static func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(2)) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

/// Accumulates everything a pipe's read end produces until EOF or a cancel.
private final class PipeDrain: Sendable {
    private struct State {
        var data = Data()
        var finished = false
        var continuation: CheckedContinuation<Data, Never>?
    }

    private let state = Mutex(State())
    private let handle: FileHandle

    init(_ pipe: Pipe) {
        handle = pipe.fileHandleForReading
        handle.readabilityHandler = { [self] handle in
            // Read under the lock so a cancel can never close the handle
            // mid-read.
            let ended: Bool = state.withLock { state in
                guard !state.finished else { return false }
                let chunk = handle.availableData
                state.data.append(chunk)
                return chunk.isEmpty
            }
            if ended { finish() }
        }
    }

    func drainToEnd() async -> Data {
        await withCheckedContinuation { continuation in
            let alreadyFinished: Data? = state.withLock { state in
                if state.finished { return state.data }
                state.continuation = continuation
                return nil
            }
            if let alreadyFinished {
                continuation.resume(returning: alreadyFinished)
            }
        }
    }

    /// Runs once: the first of EOF and a cancel takes the waiting
    /// continuation.
    func finish() {
        handle.readabilityHandler = nil
        let waiting: (CheckedContinuation<Data, Never>, Data)? = state.withLock { state in
            guard !state.finished else { return nil }
            state.finished = true
            try? handle.close()
            guard let continuation = state.continuation else { return nil }
            state.continuation = nil
            return (continuation, state.data)
        }
        if let (continuation, data) = waiting { continuation.resume(returning: data) }
    }
}
