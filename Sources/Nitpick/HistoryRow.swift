import NitpickCore
import SwiftUI

/// One History entry, read-only: the filed Review Session's identity, then
/// each filed Finding with its issue link and summary. No editing, no
/// YouTrack fetches, no screenshots. Shared by the ⌘Y History window and the
/// in-place filing result so the two surfaces stay identical by construction.
struct HistoryRow: View {
    let entry: HistoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text(entry.project.name)
                    .font(.callout.weight(.semibold))
                Text("\(entry.build.bundleID) \(entry.build.version) (\(entry.build.buildNumber))")
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                Text(entry.startedAt.formatted(date: .abbreviated, time: .shortened))
                    .foregroundStyle(.secondary)
            }
            ForEach(entry.findings, id: \.issue.idReadable) { finding in
                HStack(spacing: 8) {
                    Link(finding.issue.idReadable, destination: finding.issue.url)
                        .font(.callout)
                        .motionPressFeedback()
                    let summary = finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
                    Text(summary.isEmpty ? "Untitled Finding" : summary)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
