import Foundation

/// The filing button's honest state: the tray's marks plus the shell's run
/// facts, rendered without any view-layer guesswork.
public enum FilingPhase: Equatable, Sendable {
    case idle(unfiled: Int)
    case filing(completed: Int, of: Int)
    case remaining(unfiled: Int)
    case allFiled(count: Int)
}

extension ReviewSession {
    /// Derives the filing button phase from the tray's recorded marks and
    /// the shell's current run facts.
    ///
    /// `isRunning` and `stoppedByFailure` stay as inputs because the core can
    /// count acknowledged tray marks, but it cannot know whether the shell is
    /// still inside a live file-all task or whether the comeback label should
    /// say "remaining" after a failure. The phase is therefore pure over the
    /// tray plus those run facts; it never peeks at in-flight UI state.
    public func filingPhase(isRunning: Bool, stoppedByFailure: Bool) -> FilingPhase {
        let filedCount = tray.reduce(into: 0) { count, item in
            if item.filedIssue != nil {
                count += 1
            }
        }
        let unfiledCount = tray.count - filedCount

        // An empty tray has no unfiled Findings, but "done" is a payoff,
        // not a vacuous truth — a session with nothing captured is idle.
        if tray.isEmpty {
            return .idle(unfiled: 0)
        }

        if isRunning {
            return .filing(completed: filedCount, of: tray.count)
        }
        if unfiledCount == 0 {
            return .allFiled(count: tray.count)
        }
        if stoppedByFailure {
            return .remaining(unfiled: unfiledCount)
        }
        return .idle(unfiled: unfiledCount)
    }
}
