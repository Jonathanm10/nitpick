import Foundation

/// What the shell is running right now, and how the last File all run
/// ended. One value, so "busy" and "filing" can never disagree.
public struct ShellActivity: Equatable, Sendable {
    /// Filing is the only work a reader tells apart: the File all button
    /// counts its progress and frozen Tray rows say "Filing…".
    public enum Work: Equatable, Sendable {
        case filing
        case other
    }

    public private(set) var running: Work?
    /// Why the last File all run stopped. Unrelated work leaves it alone, so
    /// the Tray row that shows it keeps showing it; the next File all run
    /// or a Review Session opening or closing forgets it.
    public private(set) var filingFailure: FilingFailure?

    public init() {}

    public var isBusy: Bool { running != nil }
    public var isFiling: Bool { running == .filing }

    public mutating func begin(_ work: Work) {
        running = work
        if work == .filing { filingFailure = nil }
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
