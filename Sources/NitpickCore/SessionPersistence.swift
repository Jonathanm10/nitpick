import Foundation

/// A filed Review Session in the local history log: what was reviewed and
/// what its Findings became, kept so the designer can answer "did I already
/// file this?" without searching YouTrack. A log entry, never a mirror —
/// no live status, no sync (write-only v1; the v2 verify pass owns that).
public struct HistoryEntry: Equatable, Sendable, Identifiable {
    /// A Finding's read-only record: its text payload and Device Context
    /// plus the issue link it produced. The screenshots are deliberately
    /// absent — they live on the filed issue; the log stays lean.
    public struct FiledFinding: Equatable, Sendable {
        public var summary: String
        public var description: String
        public var deviceContext: DeviceContext
        /// The effective Design Reference the issue was filed under —
        /// frozen onto the Finding at issue creation, so this always
        /// matches the issue's `Design:` line regardless of later
        /// session-level edits.
        public var designReference: URL?
        public var issue: FiledIssue

        public init(
            summary: String,
            description: String,
            deviceContext: DeviceContext,
            designReference: URL? = nil,
            issue: FiledIssue
        ) {
            self.summary = summary
            self.description = description
            self.deviceContext = deviceContext
            self.designReference = designReference
            self.issue = issue
        }
    }

    public var build: BuildIdentity
    public var project: YouTrackProject
    public var startedAt: Date
    /// Every filed Finding, in tray order.
    public var findings: [FiledFinding]

    /// A Review Session's identity is its start moment — the same value the
    /// metadata block's session line carries (ADR-0004).
    public var id: Date { startedAt }

    public init(
        build: BuildIdentity,
        project: YouTrackProject,
        startedAt: Date,
        findings: [FiledFinding]
    ) {
        self.build = build
        self.project = project
        self.startedAt = startedAt
        self.findings = findings
    }
}

/// Review Sessions persist locally as they are created (PRD durability):
/// the shell saves the open session after every mutation, filing saves
/// after every server-acknowledged step, and a relaunch resumes whatever a
/// quit or crash left behind. A fully filed session moves from the open
/// slot into the history log. All of it plain files under the workspace —
/// in-process filesystem effects, unseamed by design.
extension AppCore {
    /// Persists the open session — cheap enough to call on every mutation.
    /// The manifest is JSON; each capture is written once as a sidecar PNG
    /// (a Finding's screenshot never changes), so a per-keystroke save
    /// rewrites kilobytes, never megapixels.
    public func saveOpenSession(_ session: ReviewSession) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: openSessionCapturesDirectory, withIntermediateDirectories: true)
        // Captures before the manifest: a manifest must never name a PNG
        // that is not on disk yet.
        for item in session.tray {
            let file = captureFile(for: item.id)
            if !fileManager.fileExists(atPath: file.path) {
                try item.finding.screenshotPNG.write(to: file, options: .atomic)
            }
        }
        let data = try Self.storageEncoder().encode(StoredSession(session))
        // Atomic: a crash mid-write keeps the previous good manifest.
        try data.write(to: openSessionManifest, options: .atomic)
        // Prune discarded items' captures only after the manifest stopped
        // naming them; a crash before this leaves harmless orphans the
        // next save removes.
        let live = Set(session.tray.map { captureFile(for: $0.id).lastPathComponent })
        let captures = (try? fileManager.contentsOfDirectory(
            at: openSessionCapturesDirectory, includingPropertiesForKeys: nil
        )) ?? []
        for file in captures where !live.contains(file.lastPathComponent) {
            try? fileManager.removeItem(at: file)
        }
    }

    /// The session a quit or crash left open — the relaunch path. Nil when
    /// none is open. A fully filed session found here (a crash landed
    /// between the last filing mark and the history record) finishes its
    /// move into history and reports nothing open.
    public func loadOpenSession() throws -> ReviewSession? {
        guard let data = try? Data(contentsOf: openSessionManifest) else { return nil }
        let stored = try JSONDecoder().decode(StoredSession.self, from: data)
        guard stored.schemaVersion == Self.storageSchemaVersion else {
            throw UnsupportedStoredSchema(version: stored.schemaVersion)
        }
        var session = ReviewSession(
            build: stored.build,
            project: stored.project,
            startedAt: stored.startedAt,
            designReference: stored.designReference
        )
        session.tray = try stored.tray.map { item in
            var finding = Finding(
                summary: item.summary,
                description: item.description,
                screenshotPNG: try Data(contentsOf: captureFile(for: item.id)),
                deviceContext: item.deviceContext,
                designReference: item.designReference
            )
            finding.annotations = item.annotations
            return TrayItem(id: item.id, finding: finding, filingProgress: item.filingProgress)
        }
        if !session.tray.isEmpty, session.tray.allSatisfy({ $0.filedIssue != nil }) {
            try recordInHistory(session)
            return nil
        }
        return session
    }

    /// Ends the open session without filing — the designer abandoned it
    /// by starting over. Removes the persisted slot so a relaunch does
    /// not resurrect a session that was deliberately left behind.
    public func clearOpenSession() throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: openSessionDirectory.path) {
            try fileManager.removeItem(at: openSessionDirectory)
        }
    }

    /// The local history log: every filed session, newest first. Reads
    /// only the workspace — no YouTrack state, ever.
    public func sessionHistory() throws -> [HistoryEntry] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: historyDirectory, includingPropertiesForKeys: nil
        )) ?? []
        return try files
            .filter { $0.pathExtension == "json" }
            .map { file -> HistoryEntry in
                let stored = try JSONDecoder().decode(StoredHistoryEntry.self, from: try Data(contentsOf: file))
                guard stored.schemaVersion == Self.storageSchemaVersion else {
                    throw UnsupportedStoredSchema(version: stored.schemaVersion)
                }
                return HistoryEntry(
                    build: stored.build,
                    project: stored.project,
                    startedAt: stored.startedAt,
                    findings: stored.findings.map {
                        HistoryEntry.FiledFinding(
                            summary: $0.summary,
                            description: $0.description,
                            deviceContext: $0.deviceContext,
                            designReference: $0.designReference,
                            issue: $0.issue
                        )
                    }
                )
            }
            .sorted { $0.startedAt > $1.startedAt }
    }

    /// Freezes a fully filed session into the history log and clears the
    /// open slot. Keyed by the session's start moment, so recording the
    /// same Review Session again (more captures filed after a file-all)
    /// replaces its entry instead of duplicating it.
    func recordInHistory(_ session: ReviewSession) throws {
        let stored = StoredHistoryEntry(
            schemaVersion: Self.storageSchemaVersion,
            build: session.build.identity,
            project: session.project,
            startedAt: session.startedAt,
            findings: session.tray.compactMap { item in
                item.filedIssue.map {
                    StoredFiledFinding(
                        summary: item.finding.summary,
                        description: item.finding.description,
                        deviceContext: item.finding.deviceContext,
                        designReference: item.finding.designReference,
                        issue: $0
                    )
                }
            }
        )
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: historyDirectory, withIntermediateDirectories: true)
        let data = try Self.storageEncoder().encode(stored)
        try data.write(to: historyFile(for: session.startedAt), options: .atomic)
        // The entry exists before the slot clears: a crash between the two
        // heals on the next load, and the record overwrite is idempotent.
        try clearOpenSession()
    }

    // MARK: - Locations

    private var openSessionDirectory: URL {
        workspaceDirectory.appendingPathComponent("open-session", isDirectory: true)
    }

    private var openSessionManifest: URL {
        openSessionDirectory.appendingPathComponent("session.json")
    }

    private var openSessionCapturesDirectory: URL {
        openSessionDirectory.appendingPathComponent("captures", isDirectory: true)
    }

    private func captureFile(for id: TrayItem.ID) -> URL {
        openSessionCapturesDirectory.appendingPathComponent("\(id.uuidString).png")
    }

    private var historyDirectory: URL {
        workspaceDirectory.appendingPathComponent("history", isDirectory: true)
    }

    /// One file per session, named by its start moment (fractional seconds
    /// keep same-day sessions distinct; colons swapped out for filesystem
    /// friendliness). Stable across relaunches because the stored Date
    /// round-trips exactly through JSON.
    private func historyFile(for startedAt: Date) -> URL {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let key = formatter.string(from: startedAt).replacingOccurrences(of: ":", with: "-")
        return historyDirectory.appendingPathComponent("\(key).json")
    }

    // MARK: - Storage schema

    /// Bump on any incompatible change to the stored shapes below; a reader
    /// seeing a version it does not know refuses loudly instead of guessing.
    static let storageSchemaVersion = 1

    /// Deterministic bytes (sorted keys), like every serializer in the core.
    private static func storageEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

/// A persisted session or history file written by a schema this build does
/// not read — a newer nitpick touched the workspace.
struct UnsupportedStoredSchema: Error, Equatable, LocalizedError {
    var version: Int

    var errorDescription: String? {
        "This review data was saved by a newer version of nitpick (schema \(version)). Update nitpick to open it."
    }
}

// MARK: - Stored shapes (schema version 1)

/// The open-session manifest. Screenshots live beside it as
/// `captures/<item-id>.png`; Annotation edit history is deliberately not
/// stored — undo starts fresh after a relaunch, like everywhere else.
private struct StoredSession: Codable {
    var schemaVersion: Int
    var build: Build
    var project: YouTrackProject
    var startedAt: Date
    /// Absent in manifests written before issue 09 — decodes as nil, which
    /// is exactly what those sessions meant. Additive, so schema version 1
    /// stands.
    var designReference: URL?
    var tray: [StoredTrayItem]

    init(_ session: ReviewSession) {
        schemaVersion = AppCore.storageSchemaVersion
        build = session.build
        project = session.project
        startedAt = session.startedAt
        designReference = session.designReference
        tray = session.tray.map(StoredTrayItem.init)
    }
}

private struct StoredTrayItem: Codable {
    var id: UUID
    var summary: String
    var description: String
    var deviceContext: DeviceContext
    var annotations: [Annotation]
    var designReference: URL?
    var filingProgress: FilingProgress

    init(_ item: TrayItem) {
        id = item.id
        summary = item.finding.summary
        description = item.finding.description
        deviceContext = item.finding.deviceContext
        annotations = item.finding.annotations
        designReference = item.finding.designReference
        filingProgress = item.filingProgress
    }
}

private struct StoredHistoryEntry: Codable {
    var schemaVersion: Int
    var build: BuildIdentity
    var project: YouTrackProject
    var startedAt: Date
    var findings: [StoredFiledFinding]
}

private struct StoredFiledFinding: Codable {
    var summary: String
    var description: String
    var deviceContext: DeviceContext
    var designReference: URL?
    var issue: FiledIssue
}
