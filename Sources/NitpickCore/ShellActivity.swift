import Foundation

/// One value, so "busy" and "filing" can never disagree.
public struct ShellActivity: Equatable, Sendable {
    /// Filing is the only work a reader tells apart: the File all button
    /// shows its progress.
    public enum Work: Equatable, Sendable {
        case filing
        case other
    }

    public private(set) var running: Work?
    /// Unrelated work leaves it alone, so the Tray row that shows it keeps
    /// showing it.
    public private(set) var filingFailure: FilingFailure?

    public init() {}

    public var isBusy: Bool { running != nil }
    public var isFiling: Bool { running == .filing }

    /// One run at a time, so no run can end another's busy state, and a
    /// Build ingest can never end the session a File all run is still
    /// writing back. A refusal throws so the shell can show it: a confirmed
    /// action never does nothing silently.
    public mutating func begin(_ work: Work) throws(Busy) {
        guard running == nil else { throw Busy() }
        running = work
        if work == .filing { filingFailure = nil }
    }

    public struct Busy: LocalizedError, Equatable, Sendable {
        public var errorDescription: String? {
            "Nitpick was busy, so that didn’t run. Try again when the current step finishes."
        }
    }

    public mutating func end() {
        running = nil
    }

    public mutating func recordFilingFailure(_ message: String) {
        filingFailure = FilingFailure(message: message)
    }

    public mutating func forgetFilingFailure() {
        filingFailure = nil
    }
}

public struct FilingFailure: Equatable, Sendable {
    public let message: String
}
