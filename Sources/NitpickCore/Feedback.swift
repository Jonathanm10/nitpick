import Foundation

public enum FeedbackKind: String, Equatable, Sendable, CaseIterable {
    case bug
    case improvement

    public var tagName: String { "nitpick-feedback:\(rawValue)" }
}

public struct Feedback: Equatable, Sendable {
    public struct Environment: Equatable, Sendable {
        public struct Line: Equatable, Hashable, Sendable {
            public var label: String
            public var value: String
        }

        public var nitpick: String
        public var macOS: String
        public var xcode: String
        public var build: String?
        public var captureSource: String?

        public init(nitpick: String, macOS: String, xcode: String, build: String? = nil, captureSource: String? = nil) {
            self.nitpick = nitpick
            self.macOS = macOS
            self.xcode = xcode
            self.build = build
            self.captureSource = captureSource
        }

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
    public var description: String
    public var environment: Environment
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

    var issueDescription: String {
        let text = description.trimmingCharacters(in: .whitespacesAndNewlines)
        var sections: [String] = []
        if !text.isEmpty { sections.append(text) }
        sections.append("## Environment\n" + environment.lines.map { "- \($0.label): \($0.value)" }.joined(separator: "\n"))
        return sections.joined(separator: "\n\n")
    }
}

public struct SentFeedback: Equatable, Sendable {
    public var idReadable: String
    public var url: URL
    public var warnings: [String]

    public init(idReadable: String, url: URL, warnings: [String] = []) {
        self.idReadable = idReadable
        self.url = url
        self.warnings = warnings
    }
}

extension AppCore {
    public static let feedbackProjectShortName = "NIT"

    static let feedbackImageFileName = "nitpick-window.png"

    /// Once the Issue exists, a failed tag or image upload becomes a warning
    /// instead of an error: the designer's only recourse, a retry, would
    /// create a second Issue.
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

/// No `customFields`: NIT's defaults apply and triage happens on the board.
private struct FeedbackIssuePayload: Encodable {
    struct ProjectReference: Encodable {
        var id: String
    }

    var project: ProjectReference
    var summary: String
    var description: String
}

private struct FeedbackProjectPayload: Decodable {
    var id: String
    var name: String
}
