import Foundation

/// The home trace is a presentation-neutral summary of the last filed
/// Review Session: the latest history entry plus the issue IDs the shell
/// can surface inline, capped so home never regrows into a list.
public struct HistoryTrace: Equatable, Sendable {
    public var latestEntry: HistoryEntry
    public var visibleIssues: [FiledIssue]
    public var overflowCount: Int

    /// History is newest first. The trace only needs the first filed session,
    /// and it stays absent when history is still empty.
    public init?(history: [HistoryEntry]) {
        guard let latestEntry = history.first else { return nil }
        self.latestEntry = latestEntry
        visibleIssues = Array(latestEntry.findings.prefix(3).map(\.issue))
        overflowCount = max(0, latestEntry.findings.count - visibleIssues.count)
    }
}
