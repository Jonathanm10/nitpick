import Foundation
import NitpickCore
import Testing

/// The golden files the TypeScript port in `core/` is written against: what
/// this app renders and stores, committed under `core/test/golden/` next to
/// a JSON description of each input (see the README there). A golden that
/// drifts from what the Swift code produces fails with its path. Set
/// NITPICK_RECORD_SNAPSHOTS=1 to (re)record, as for the image snapshots.
enum GoldenFiles {
    static var isRecording: Bool {
        ProcessInfo.processInfo.environment["NITPICK_RECORD_SNAPSHOTS"] == "1"
    }

    /// `core/test/golden/`, located from this source file so tests never
    /// depend on the working directory.
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // Support/
        .deletingLastPathComponent()  // NitpickCoreTests/
        .deletingLastPathComponent()  // Tests/
        .deletingLastPathComponent()  // repository root
        .appendingPathComponent("core/test/golden", isDirectory: true)

    static func url(_ path: String) -> URL {
        directory.appendingPathComponent(path)
    }

    static func read(_ path: String) throws -> Data {
        try Data(contentsOf: url(path))
    }

    /// Checks `data` against the golden at `path` byte for byte, or records
    /// it when recording.
    static func expect(
        _ data: Data,
        matches path: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let golden = url(path)
        let name = "core/test/golden/\(path)"
        if isRecording {
            try FileManager.default.createDirectory(
                at: golden.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try data.write(to: golden, options: .atomic)
            Issue.record(
                "Recorded \(name); rerun without NITPICK_RECORD_SNAPSHOTS.",
                sourceLocation: sourceLocation
            )
            return
        }
        guard let expected = try? Data(contentsOf: golden) else {
            Issue.record(
                "No golden at \(name); record it with NITPICK_RECORD_SNAPSHOTS=1.",
                sourceLocation: sourceLocation
            )
            return
        }
        guard expected != data else { return }
        let candidate = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString)-\(golden.lastPathComponent)")
        try data.write(to: candidate)
        let offset = zip(expected, data).enumerated().first { $0.element.0 != $0.element.1 }?.offset
            ?? min(expected.count, data.count)
        let message = "Golden \(name) differs from what the Swift app writes: \(expected.count) bytes "
            + "committed, \(data.count) written, first difference at byte \(offset). "
            + "Swift's output is at \(candidate.path); re-record with NITPICK_RECORD_SNAPSHOTS=1 if the change is intended."
        Issue.record(Comment(rawValue: message), sourceLocation: sourceLocation)
    }

    /// Checks the description of a golden's input, `<golden>.input.json`
    /// next to the golden at `path`, the same way.
    static func expectInput(
        _ input: some Encodable,
        describing path: String,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(input) + Data("\n".utf8)
        try expect(data, matches: inputPath(for: path), sourceLocation: sourceLocation)
    }

    static func inputPath(for path: String) -> String {
        (path as NSString).deletingPathExtension + ".input.json"
    }
}

/// Plain JSON descriptions of the Swift values behind the goldens, so the
/// TypeScript tests can build the same values without reading Swift. Types
/// whose own encoding is already a plain record (`BuildIdentity`,
/// `YouTrackProject`, `DeviceContext`, triage, `FiledIssue`) appear as
/// themselves; dates, enums with payloads and Annotations get a neutral
/// shape here. Image bytes are left out: the stored JSON never holds them.
enum GoldenDescription {
    /// A `Date` exactly: Swift stores seconds since 2001-01-01T00:00:00Z.
    /// The ISO 8601 form is for reading, at millisecond precision.
    struct Instant: Encodable {
        var iso8601: String
        var secondsSinceReferenceDate: Double

        init(_ date: Date) {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            iso8601 = formatter.string(from: date)
            secondsSinceReferenceDate = date.timeIntervalSinceReferenceDate
        }
    }

    struct Point: Encodable {
        var x: Double
        var y: Double

        init(_ point: CGPoint) {
            x = point.x
            y = point.y
        }
    }

    struct Rect: Encodable {
        var x: Double
        var y: Double
        var width: Double
        var height: Double
    }

    /// One shape per `kind`; only that kind's fields are present.
    struct Annotation: Encodable {
        var kind: String
        var color: AnnotationColor
        var points: [Point]?
        var from: Point?
        var to: Point?
        var rect: Rect?
        var text: String?
        var at: Point?

        init(_ annotation: NitpickCore.Annotation) {
            color = annotation.color
            switch annotation.shape {
            case .pen(let points):
                kind = "pen"
                self.points = points.map(Point.init)
            case .arrow(let from, let to):
                kind = "arrow"
                self.from = Point(from)
                self.to = Point(to)
            case .rectangle(let rect):
                kind = "rectangle"
                self.rect = Rect(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
            case .label(let text, let position):
                kind = "label"
                self.text = text
                at = Point(position)
            }
        }
    }

    /// `state` names the case; the step states carry the created Issue's
    /// IDs, `filed` carries the Issue.
    struct FilingProgress: Encodable {
        var state: String
        var issueID: String?
        var idReadable: String?
        var issue: FiledIssue?

        init(_ progress: NitpickCore.FilingProgress) {
            switch progress {
            case .notStarted:
                state = "notStarted"
            case .issueCreated(let issueID, let idReadable):
                state = "issueCreated"
                self.issueID = issueID
                self.idReadable = idReadable
            case .attachmentsUploaded(let issueID, let idReadable):
                state = "attachmentsUploaded"
                self.issueID = issueID
                self.idReadable = idReadable
            case .reviewTagged(let issueID, let idReadable):
                state = "reviewTagged"
                self.issueID = issueID
                self.idReadable = idReadable
            case .filed(let issue):
                state = "filed"
                self.issue = issue
            }
        }
    }

    struct DesignSnapshot: Encodable {
        var id: UUID
        var dataVersion: UUID
        var name: String
        var mediaType: DesignSnapshotMediaType

        init(_ snapshot: NitpickCore.DesignSnapshot) {
            id = snapshot.id
            dataVersion = snapshot.dataVersion
            name = snapshot.name
            mediaType = snapshot.mediaType
        }
    }

    struct Finding: Encodable {
        var summary: String
        var description: String
        var deviceContext: DeviceContext
        var designReference: URL?
        var type: FindingType
        var priority: FindingPriority?
        var assignee: FindingAssignee?
        var annotations: [Annotation]
        var designSnapshots: [DesignSnapshot]

        init(_ finding: NitpickCore.Finding) {
            summary = finding.summary
            description = finding.description
            deviceContext = finding.deviceContext
            designReference = finding.designReference
            type = finding.type
            priority = finding.priority
            assignee = finding.assignee
            annotations = finding.annotations.map(Annotation.init)
            designSnapshots = finding.designSnapshots.map(DesignSnapshot.init)
        }
    }

    struct TrayItem: Encodable {
        var id: UUID
        var filingProgress: FilingProgress
        var finding: Finding

        init(_ item: NitpickCore.TrayItem) {
            id = item.id
            filingProgress = FilingProgress(item.filingProgress)
            finding = Finding(item.finding)
        }
    }

    struct Session: Encodable {
        var build: Build
        var project: YouTrackProject
        var startedAt: Instant
        var designReference: URL?
        var tray: [TrayItem]

        init(_ session: ReviewSession) {
            build = session.build
            project = session.project
            startedAt = Instant(session.startedAt)
            designReference = session.designReference
            tray = session.tray.map(TrayItem.init)
        }
    }

    struct HistoryEntry: Encodable {
        struct FiledFinding: Encodable {
            var summary: String
            var description: String
            var deviceContext: DeviceContext
            var designReference: URL?
            var issue: FiledIssue
        }

        var build: BuildIdentity
        var project: YouTrackProject
        var startedAt: Instant
        var findings: [FiledFinding]

        init(_ entry: NitpickCore.HistoryEntry) {
            build = entry.build
            project = entry.project
            startedAt = Instant(entry.startedAt)
            findings = entry.findings.map {
                FiledFinding(
                    summary: $0.summary,
                    description: $0.description,
                    deviceContext: $0.deviceContext,
                    designReference: $0.designReference,
                    issue: $0.issue
                )
            }
        }
    }

    /// The raw Device Settings a Device Context was stamped from, in
    /// `simctl`'s vocabulary.
    struct DeviceSettings: Encodable {
        var dynamicTypeSize: String
        var appearance: String
        var increaseContrast: Bool

        init(_ settings: NitpickCore.DeviceSettings) {
            dynamicTypeSize = settings.dynamicTypeSize.rawValue
            appearance = settings.appearance.rawValue
            increaseContrast = settings.increaseContrast
        }
    }

    struct FeedbackEnvironment: Encodable {
        var nitpick: String
        var macOS: String
        var xcode: String
        var build: String?
        var captureSource: String?

        init(_ environment: NitpickCore.Feedback.Environment) {
            nitpick = environment.nitpick
            macOS = environment.macOS
            xcode = environment.xcode
            build = environment.build
            captureSource = environment.captureSource
        }
    }

    struct Feedback: Encodable {
        var kind: String
        var title: String
        var description: String
        var environment: FeedbackEnvironment

        init(_ feedback: NitpickCore.Feedback) {
            kind = feedback.kind.rawValue
            title = feedback.title
            description = feedback.description
            environment = FeedbackEnvironment(feedback.environment)
        }
    }
}
