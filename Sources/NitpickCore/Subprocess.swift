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
        // that exits instantly can't slip past it.
        let exitCode: Int32 = try await withCheckedThrowingContinuation { continuation in
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do {
                try process.run()
            } catch {
                process.terminationHandler = nil
                continuation.resume(throwing: error)
            }
        }

        return SubprocessResult(
            exitCode: exitCode,
            standardOutput: await stdout.drainToEnd(),
            standardError: await stderr.drainToEnd()
        )
    }
}

/// Accumulates everything a pipe's read end produces; completes at EOF.
private final class PipeDrain: Sendable {
    private struct State {
        var data = Data()
        var finished = false
        var continuation: CheckedContinuation<Data, Never>?
    }

    private let state = Mutex(State())

    init(_ pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = { [self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                let (continuation, data): (CheckedContinuation<Data, Never>?, Data) =
                    state.withLock { state in
                        state.finished = true
                        defer { state.continuation = nil }
                        return (state.continuation, state.data)
                    }
                continuation?.resume(returning: data)
            } else {
                state.withLock { $0.data.append(chunk) }
            }
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
}
