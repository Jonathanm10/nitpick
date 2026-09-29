import Foundation

/// What kind of Feedback a designer sends about nitpick itself. Mirrors the
/// Finding's Type values but is a separate field with its own tag namespace:
/// a Feedback is never a Finding, and the `nitpick-type:*` tags keep
/// meaning "about the Build under review" (glossary: Feedback).
public enum FeedbackKind: String, Equatable, Sendable, CaseIterable {
    case bug
    case improvement

    /// The tag the nitpick team filters the `NIT` board by — a tag rather
    /// than a custom field, so no project schema is read or written.
    public var tagName: String { "nitpick-feedback:\(rawValue)" }
}

/// A designer's report about nitpick itself (glossary: Feedback): sent as
/// exactly one Issue to the nitpick project, never part of a Review Session
/// or History.
public struct Feedback: Equatable, Sendable {
    /// The read-only Environment section: gathered by the shell (versions,
    /// and the Build and Capture Source while a Review Session is open) and
    /// passed in as values — the core never reads the process or bundle, so
    /// tests pin exact strings. The core owns the labels and their order;
    /// missing values are the shell's to spell ("unknown") and are sent
    /// verbatim. Never carries the token or the instance URL.
    public struct Environment: Equatable, Sendable {
        /// One rendered line, e.g. "macOS" → "Version 26.1 (Build 25B78)".
        public struct Line: Equatable, Hashable, Sendable {
            public var label: String
            public var value: String
        }

        public var nitpick: String
        public var macOS: String
        public var xcode: String
        /// Only while a Review Session is open.
        public var build: String?
        /// Only while a Review Session is open.
        public var captureSource: String?

        public init(nitpick: String, macOS: String, xcode: String, build: String? = nil, captureSource: String? = nil) {
            self.nitpick = nitpick
            self.macOS = macOS
            self.xcode = xcode
            self.build = build
            self.captureSource = captureSource
        }

        /// The lines in the fixed order they are previewed and sent. A
        /// value's newlines become spaces so one value stays one bullet.
        public var lines: [Line] {
            let pairs: [(String, String?)] = [
                ("Nitpick", nitpick),
                ("macOS", macOS),
                ("Xcode", xcode),
                ("Build", build),
                ("Capture Source", captureSource),
            ]
            return pairs.compactMap { label, value in
                value.map { Line(label: label, value: Self.singleLine($0)) }
            }
        }

        private static func singleLine(_ value: String) -> String {
            value.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).joined(separator: " ")
        }
    }

    public var kind: FeedbackKind
    public var title: String
    /// Optional; an empty description sends the Environment section alone.
    public var description: String
    public var environment: Environment
    /// An optional PNG of the nitpick window, uploaded after the Issue exists.
    public var imagePNG: Data?

    public init(
        kind: FeedbackKind,
        title: String,
        description: String = "",
        environment: Environment,
        imagePNG: Data? = nil
    ) {
        self.kind = kind
        self.title = title
        self.description = description
        self.environment = environment
        self.imagePNG = imagePNG
    }

    /// The Issue body: plain Markdown, the designer's text followed by an
    /// `## Environment` bullet list. No ADR-0004 metadata block — nothing
    /// reads Feedback back.
    var issueDescription: String {
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        var sections: [String] = []
        if !text.isEmpty { sections.append(text) }
        sections.append("## Environment\n" + environment.lines.map { "- \($0.label): \($0.value)" }.joined(separator: "\n"))
        return sections.joined(separator: "\n\n")
    }
}

/// The Issue a Feedback became — what the sheet shows after sending.
public struct SentFeedback: Equatable, Sendable {
    /// The human-readable issue ID, e.g. "NIT-42".
    public var idReadable: String
    /// The issue's page on the instance.
    public var url: URL
    /// Steps after the Issue existed that did not land (the tag, the window
    /// image), in designer-facing words. The Issue is still returned: a
    /// retry would file a duplicate, so these are shown, never thrown.
    public var warnings: [String]

    public init(idReadable: String, url: URL, warnings: [String] = []) {
        self.idReadable = idReadable
        self.url = url
        self.warnings = warnings
    }
}

extension AppCore {
    /// The YouTrack project every Feedback lands in. Only the shortName is
    /// fixed: the internal ID is resolved at send time and never persisted,
    /// so a re-created project costs nothing.
    public static let feedbackProjectShortName = "NIT"

    /// The attachment name the optional window image carries.
    static let feedbackImageFileName = "nitpick-window.png"

    /// Sends one Feedback as exactly one Issue in the `NIT` project, with the
    /// designer's own connected YouTrack token. The ladder: resolve the
    /// `nitpick-feedback:<kind>` tag (created if missing) → resolve the
    /// project by shortName → create the Issue (summary + Markdown body, no
    /// custom fields: Priority, Stage and Assignee stay project defaults) →
    /// apply the tag → upload the window image if any. Both resolutions run
    /// before the Issue exists, so a refusal there leaves no orphan. Once
    /// the Issue exists nothing throws: a failed tag or image (auth errors
    /// included) becomes a warning on the returned `SentFeedback`, because
    /// the designer's only recourse, a retry, would create a second Issue.
    /// Unlike filing, nothing is recorded between steps: Feedback is not
    /// resumable and never touches the workspace or History.
    public func send(_ feedback: Feedback) async throws -> SentFeedback {
        let summary = feedback.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty else { throw YouTrackError.feedbackTitleRequired }
        guard let credentials = try savedYouTrackCredentials() else { throw YouTrackError.notConnected }

        let tagName = feedback.kind.tagName
        let tagID = try await tagID(named: tagName, with: credentials)
        let shortName = Self.feedbackProjectShortName
        let project: FeedbackProjectPayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            path: "api/admin/projects/\(shortName)", query: "fields=id,name",
            deniedAction: "read the \(shortName) project"
        )

        let created: CreatedIssuePayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues", query: "fields=id,idReadable",
            body: try Self.jsonBody(FeedbackIssuePayload(
                project: .init(id: project.id),
                summary: summary,
                description: feedback.issueDescription
            )),
            deniedAction: "create an issue in \(project.name)"
        )
        var warnings: [String] = []
        do {
            try await applyTag(tagID, toIssue: created.id, named: tagName, credentials: credentials)
        } catch {
            warnings.append("The \(tagName) tag could not be applied.")
        }

        if let imagePNG = feedback.imagePNG {
            do {
                let _: [AttachmentPayload] = try await requestYouTrack(
                    instanceURL: credentials.instanceURL, token: credentials.token,
                    method: "POST", path: "api/issues/\(created.id)/attachments", query: "fields=id,name",
                    body: Self.attachmentsBody([
                        AttachmentFile(fileName: Self.feedbackImageFileName, contentType: "image/png", data: imagePNG),
                    ]),
                    deniedAction: "attach the window image"
                )
            } catch {
                warnings.append("The window image could not be attached.")
            }
        }

        return SentFeedback(
            idReadable: created.idReadable,
            url: Self.issueURL(instanceURL: credentials.instanceURL, idReadable: created.idReadable),
            warnings: warnings
        )
    }
}

// MARK: - Wire payloads

/// The Feedback creation body. Deliberately has no `customFields` key: `NIT`
/// fills Priority and Stage with its defaults, and triage happens on the
/// board.
private struct FeedbackIssuePayload: Encodable {
    struct ProjectReference: Encodable {
        var id: String
    }

    var project: ProjectReference
    var summary: String
    var description: String
}

/// The subset of `GET api/admin/projects/{shortName}` the core reads.
private struct FeedbackProjectPayload: Decodable {
    var id: String
    var name: String
}
