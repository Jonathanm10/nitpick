import NitpickCore
import SwiftUI

struct HistoryWindow: View {
    @Bindable var model: AppModel

    var body: some View {
        Group {
            if model.history.isEmpty {
                emptyState
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(model.history) { entry in
                            historyRow(entry)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var emptyState: some View {
        ContentUnavailableView(
            "No History yet",
            systemImage: "clock.arrow.circlepath",
            description: Text("Filed Review Sessions appear here after they are filed.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The read-only row matches the old home strip exactly: the filed
    /// session identity, then each filed Finding with its issue link and
    /// summary. No editing, no YouTrack fetches.
    private func historyRow(_ entry: HistoryEntry) -> some View {
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
                    let summary = finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
                    Text(summary.isEmpty ? "Untitled Finding" : summary)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct HistoryTraceLine: View {
    let trace: HistoryTrace
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ZStack(alignment: .leading) {
            Button {
                openHistory()
            } label: {
                HStack(spacing: 6) {
                    Text(trace.latestEntry.build.bundleID)
                    Text(trace.latestEntry.build.version)
                    Text("(\(trace.latestEntry.build.buildNumber))")
                    Text("·")
                    Text(trace.latestEntry.startedAt.formatted(date: .abbreviated, time: .shortened))
                    Spacer(minLength: 0)
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())

            HStack(spacing: 8) {
                ForEach(trace.visibleIssues, id: \.idReadable) { issue in
                    Link(issue.idReadable, destination: issue.url)
                        .font(.callout)
                }
                if trace.overflowCount > 0 {
                    Button("+\(trace.overflowCount)") {
                        openHistory()
                    }
                    .buttonStyle(.plain)
                    .font(.callout)
                }
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    private func openHistory() {
        openWindow(id: "history")
    }
}
