import Foundation

/// One sitting in which a designer reviews a Build. Fixes the shared context
/// exactly once — Build + YouTrack project — so filing never re-asks
/// (PRD session boundary). Its Findings may span multiple Device Contexts.
public struct ReviewSession: Equatable, Sendable {
    public var build: Build
    /// The project every Finding of this session files into, chosen once
    /// at session start.
    public var project: YouTrackProject
    /// Stamped once at session start. Rendered into every issue's session
    /// line, which is what makes one Review Session auditable as a unit
    /// (PRD story 33) — hence a timestamp, not a bare date: two sessions on
    /// the same day must stay distinguishable.
    public var startedAt: Date
    /// The session tray: every captured Finding, in capture order, each
    /// with its filing progress. Captures land here with no filing dialog
    /// (PRD story 22); mutated only through the tray methods below and by
    /// filing itself.
    public internal(set) var tray: [TrayItem] = []

    public init(build: Build, project: YouTrackProject, startedAt: Date = Date()) {
        self.build = build
        self.project = project
        self.startedAt = startedAt
    }
}

/// A Finding's seat in the session tray: the Finding itself plus how far
/// filing has progressed. Identity belongs to the tray — two byte-identical
/// captures stay distinct items.
public struct TrayItem: Equatable, Sendable, Identifiable {
    public let id: UUID
    /// Edited through `ReviewSession.updateFinding(id:_:)` until the item
    /// freezes.
    public internal(set) var finding: Finding
    /// Advanced only by filing, one server-acknowledged step at a time.
    public internal(set) var filingProgress: FilingProgress

    init(finding: Finding) {
        self.id = UUID()
        self.finding = finding
        self.filingProgress = .notStarted
    }

    /// Rebuilds a persisted item with its original identity and filing
    /// marks — the resume path. New captures go through `init(finding:)`.
    init(id: UUID, finding: Finding, filingProgress: FilingProgress) {
        self.id = id
        self.finding = finding
        self.filingProgress = filingProgress
    }

    /// The issue this Finding became, once the whole filing ladder ran.
    public var filedIssue: FiledIssue? {
        if case .filed(let issue) = filingProgress { return issue }
        return nil
    }

    /// Editable and discardable only while nothing about the item exists
    /// on the instance (PRD stories 18, 23). The moment its issue is
    /// created the item freezes, so a filing retry can never diverge from
    /// what the issue already says.
    public var isEditable: Bool { filingProgress == .notStarted }
}

/// How far a tray item's filing has progressed. Filing records every
/// server-acknowledged step before firing the next request, so a retry
/// resumes instead of repeating — no Finding is ever double-filed. (A
/// response lost in transit is the one irreducible ambiguity; nothing the
/// instance acknowledged is ever re-sent.)
public enum FilingProgress: Equatable, Sendable, Codable {
    /// Nothing about this item exists on the instance yet.
    case notStarted
    /// `POST api/issues` succeeded: the issue exists but carries neither
    /// attachments nor tag.
    case issueCreated(issueID: String, idReadable: String)
    /// Both screenshot variants are attached; only the design-review tag
    /// is missing.
    case attachmentsUploaded(issueID: String, idReadable: String)
    /// The whole ladder ran: the Finding is exactly one filed issue.
    case filed(FiledIssue)
}

extension ReviewSession {
    /// Drops a capture into the tray — no filing dialog, the review keeps
    /// flowing. Returns the new item's identity for selection.
    @discardableResult
    public mutating func addFinding(_ finding: Finding) -> TrayItem.ID {
        let item = TrayItem(finding: finding)
        tray.append(item)
        return item.id
    }

    /// Edits an item's Finding in place — summary, description,
    /// Annotations. Refused (a no-op) once the item is no longer editable:
    /// its issue already exists, and the tray must never diverge from it.
    public mutating func updateFinding(id: TrayItem.ID, _ edit: (inout Finding) -> Void) {
        guard let index = tray.firstIndex(where: { $0.id == id }), tray[index].isEditable else { return }
        edit(&tray[index].finding)
    }

    /// Removes an item before filing. Refused once the item is no longer
    /// editable — a created issue keeps its tray record.
    public mutating func discardFinding(id: TrayItem.ID) {
        tray.removeAll { $0.id == id && $0.isEditable }
    }

    /// Every issue the tray's Findings have become, in tray order.
    public var filedIssues: [FiledIssue] {
        tray.compactMap(\.filedIssue)
    }
}

/// The device and settings in effect when a Finding is captured: device
/// model, OS version, and accessibility settings. Stamped per Finding at
/// capture time, not on the Review Session.
public struct DeviceContext: Equatable, Sendable, Codable {
    /// e.g. "iPhone 17 Pro".
    public var deviceModel: String
    /// e.g. "iOS 26.4".
    public var osName: String
    /// Human-readable non-default accessibility settings, in display order
    /// (rendered from `DeviceSettings`). Empty means everything default;
    /// the Accessibility metadata line is then omitted.
    public var accessibilitySettings: [String]

    public init(deviceModel: String, osName: String, accessibilitySettings: [String] = []) {
        self.deviceModel = deviceModel
        self.osName = osName
        self.accessibilitySettings = accessibilitySettings
    }

    /// The Device Context of a simulator device under the given Device
    /// Settings — the composition every capture stamps.
    public init(device: SimulatorDevice, settings: DeviceSettings = DeviceSettings()) {
        self.init(
            deviceModel: device.name,
            osName: device.osName,
            accessibilitySettings: settings.accessibilityDescriptions
        )
    }
}

/// A single discrepancy captured during a Review Session: one screenshot
/// plus the designer's description. Files as exactly one YouTrack issue.
///
/// Equality covers observable state only — what filing would carry — never
/// the Annotation edit history.
public struct Finding: Equatable, Sendable {
    /// The designer-typed issue summary.
    public var summary: String
    /// The designer-typed issue description; the metadata block is appended
    /// at filing time, never typed.
    public var description: String
    /// The clean native-resolution capture (the annotated variant arrives
    /// with issue 04).
    public var screenshotPNG: Data
    public var deviceContext: DeviceContext
    /// The Annotations laid over the screenshot, in stacking order.
    /// Editable through `add`/`replaceAnnotation`/`removeAnnotation` and
    /// undo/redo until the Finding is filed.
    public internal(set) var annotations: [Annotation] = []
    /// The undo/redo stacks: past and undone `annotations` states.
    var annotationUndoStack: [[Annotation]] = []
    var annotationRedoStack: [[Annotation]] = []
    /// Optional Finding-level Design Reference (ADR-0003: a link, never a
    /// rendering).
    public var designReference: URL?

    public init(
        summary: String,
        description: String,
        screenshotPNG: Data,
        deviceContext: DeviceContext,
        designReference: URL? = nil
    ) {
        self.summary = summary
        self.description = description
        self.screenshotPNG = screenshotPNG
        self.deviceContext = deviceContext
        self.designReference = designReference
    }
}

extension Finding {
    public static func == (lhs: Finding, rhs: Finding) -> Bool {
        lhs.summary == rhs.summary
            && lhs.description == rhs.description
            && lhs.screenshotPNG == rhs.screenshotPNG
            && lhs.deviceContext == rhs.deviceContext
            && lhs.designReference == rhs.designReference
            && lhs.annotations == rhs.annotations
    }
}

extension ReviewSession {
    /// The metadata block appended to every filed issue's description — a
    /// machine contract (ADR-0004), byte-stable, golden-tested. The v2
    /// verify pass parses these lines out of historical issues; any change
    /// here is a versioned schema change.
    public func metadataBlock(for finding: Finding) -> String {
        let identity = build.identity
        var lines = [
            "---",
            "App: \(identity.bundleID) \(identity.version) (\(identity.buildNumber))",
            "Device: \(finding.deviceContext.deviceModel) — \(finding.deviceContext.osName)",
        ]
        if !finding.deviceContext.accessibilitySettings.isEmpty {
            lines.append("Accessibility: \(finding.deviceContext.accessibilitySettings.joined(separator: ", "))")
        }
        if let designReference = finding.designReference {
            lines.append("Design: \(designReference.absoluteString)")
        }
        lines.append("Filed with nitpick — session \(startedAt.formatted(.iso8601))")
        return lines.joined(separator: "\n")
    }

    /// The full description a filed issue carries: designer text, blank
    /// line, metadata block — or the block alone when the designer wrote
    /// no description.
    func issueDescription(for finding: Finding) -> String {
        let designerText = finding.description.trimmingCharacters(in: .whitespacesAndNewlines)
        let block = metadataBlock(for: finding)
        return designerText.isEmpty ? block : "\(designerText)\n\n\(block)"
    }
}
