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

    public init(build: Build, project: YouTrackProject, startedAt: Date = Date()) {
        self.build = build
        self.project = project
        self.startedAt = startedAt
    }
}

/// The device and settings in effect when a Finding is captured: device
/// model, OS version, and accessibility settings. Stamped per Finding at
/// capture time, not on the Review Session.
public struct DeviceContext: Equatable, Sendable {
    /// e.g. "iPhone 17 Pro".
    public var deviceModel: String
    /// e.g. "iOS 26.4".
    public var osName: String
    /// Human-readable non-default accessibility settings, in display order.
    /// Empty means everything default; the Accessibility metadata line is
    /// then omitted. (Issue 06 adds the switching UI that populates this.)
    public var accessibilitySettings: [String]

    public init(deviceModel: String, osName: String, accessibilitySettings: [String] = []) {
        self.deviceModel = deviceModel
        self.osName = osName
        self.accessibilitySettings = accessibilitySettings
    }

    /// The Device Context of a simulator device running default settings.
    public init(device: SimulatorDevice) {
        self.init(deviceModel: device.name, osName: device.osName)
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
