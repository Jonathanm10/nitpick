import Foundation
import NitpickCore
import Testing

/// The home trace is presentation-neutral: it only preserves the last filed
/// Review Session and the issue IDs it needs to render, capped before the
/// view wordsmiths anything. The shape stays pure so the shell owns wording,
/// relative time, and link copy.
@Suite("History trace value")
struct HistoryTraceTests {
    static func issue(_ idReadable: String, suffix: String) -> FiledIssue {
        FiledIssue(
            idReadable: idReadable,
            url: URL(string: "https://nitpick.youtrack.local/issue/\(suffix)")!
        )
    }

    static func entry(startedAt: TimeInterval, issues: [FiledIssue]) -> HistoryEntry {
        HistoryEntry(
            build: BuildIdentity(bundleID: "ch.liip.nitpick", version: "1.2.3", buildNumber: "42"),
            project: YouTrackProject(id: "0-1", shortName: "NP", name: "Nitpick"),
            startedAt: Date(timeIntervalSince1970: startedAt),
            findings: issues.enumerated().map { index, issue in
                HistoryEntry.FiledFinding(
                    summary: "Finding \(index + 1)",
                    description: "Description \(index + 1)",
                    deviceContext: DeviceContext(
                        deviceModel: "iPhone 17 Pro",
                        osName: "iOS 26.4",
                        accessibilitySettings: []
                    ),
                    issue: issue
                )
            }
        )
    }

    static let olderEntry = Self.entry(
        startedAt: 1_700_000_000,
        issues: [Self.issue("OLD-1", suffix: "old-1")]
    )

    @Test("no history produces no trace")
    func noHistory() {
        #expect(HistoryTrace(history: []) == nil)
    }

    @Test("one filed issue stays visible without overflow")
    func oneIssue() {
        let latest = Self.entry(
            startedAt: 1_800_000_000,
            issues: [Self.issue("NP-101", suffix: "np-101")]
        )
        let trace = HistoryTrace(history: [latest, Self.olderEntry])

        #expect(trace?.latestEntry.startedAt == latest.startedAt)
        #expect(trace?.visibleIssues.map { $0.idReadable } == ["NP-101"])
        #expect(trace?.visibleIssues.map { $0.url.absoluteString } == ["https://nitpick.youtrack.local/issue/np-101"])
        #expect(trace?.overflowCount == 0)
    }

    @Test("exactly three issues stay visible without overflow")
    func threeIssues() {
        let latest = Self.entry(
            startedAt: 1_800_000_100,
            issues: [
                Self.issue("NP-201", suffix: "np-201"),
                Self.issue("NP-202", suffix: "np-202"),
                Self.issue("NP-203", suffix: "np-203"),
            ]
        )
        let trace = HistoryTrace(history: [latest, Self.olderEntry])

        #expect(trace?.visibleIssues.map { $0.idReadable } == ["NP-201", "NP-202", "NP-203"])
        #expect(trace?.overflowCount == 0)
    }

    @Test("more than three issues caps at three and counts overflow")
    func overflowIssues() {
        let latest = Self.entry(
            startedAt: 1_800_000_200,
            issues: [
                Self.issue("NP-301", suffix: "np-301"),
                Self.issue("NP-302", suffix: "np-302"),
                Self.issue("NP-303", suffix: "np-303"),
                Self.issue("NP-304", suffix: "np-304"),
                Self.issue("NP-305", suffix: "np-305"),
            ]
        )
        let trace = HistoryTrace(history: [latest, Self.olderEntry])

        #expect(trace?.visibleIssues.map { $0.idReadable } == ["NP-301", "NP-302", "NP-303"])
        #expect(trace?.visibleIssues.map { $0.url.absoluteString } == [
            "https://nitpick.youtrack.local/issue/np-301",
            "https://nitpick.youtrack.local/issue/np-302",
            "https://nitpick.youtrack.local/issue/np-303",
        ])
        #expect(trace?.overflowCount == 2)
    }
}
