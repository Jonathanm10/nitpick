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

        /// The open Review Session's Build and where it is captured from.
        public struct ReviewContext: Equatable, Sendable {
            public var build: BuildIdentity
            /// The simulator host app's display name, e.g. "Simulator".
            public var hostName: String?
            public var device: SimulatorDevice?

            public init(build: BuildIdentity, hostName: String?, device: SimulatorDevice?) {
                self.build = build
                self.hostName = hostName
                self.device = device
            }
        }

        public static let unknown = "unknown"

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

        /// From what the shell could read: a nil or blank version is sent as
        /// "unknown" (no bundle Info under `swift run`, no Xcode.app behind
        /// Command Line Tools). Build and Capture Source come only with a
        /// Review Session.
        public init(
            nitpickVersion: String?,
            nitpickBuild: String?,
            macOS: String?,
            xcode: String?,
            review: ReviewContext? = nil
        ) {
            let nitpick = Self.known(nitpickVersion).flatMap { version in
                Self.known(nitpickBuild).map { "\(version) (\($0))" }
            }
            self.init(
                nitpick: nitpick ?? Self.unknown,
                macOS: Self.known(macOS) ?? Self.unknown,
                xcode: Self.known(xcode) ?? Self.unknown,
                build: review.map { "\($0.build.bundleID) \($0.build.version) (\($0.build.buildNumber))" },
                captureSource: review.map(Self.captureSourceName)
            )
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

        private static func known(_ value: String?) -> String? {
            guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return value
        }

        private static func captureSourceName(_ review: ReviewContext) -> String {
            guard let device = review.device else { return "Simulator (not running)" }
            return "\(review.hostName ?? "Simulator") — \(device.name), \(device.osName)"
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

    /// The Issue summary; `send` refuses a Feedback whose summary is empty.
    public var summary: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Whether closing without sending would lose something the designer wrote.
    public var hasText: Bool {
        !summary.isEmpty || !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
    /// create a second Issue. A create whose response is lost or undecodable
    /// still throws, so that retry can duplicate; Finding filing shares the
    /// limit.
    public func send(_ feedback: Feedback) async throws -> SentFeedback {
        guard !feedback.summary.isEmpty else { throw YouTrackError.feedbackTitleRequired }
        guard let credentials = try savedYouTrackCredentials() else { throw YouTrackError.notConnected }

        let project = try await feedbackProject(with: credentials)
        let tagName = feedback.kind.tagName
        let tagID = try await tagID(named: tagName, with: credentials)
        let created = try await createIssue(
            in: project, summary: feedback.summary, description: feedback.issueDescription,
            credentials: credentials
        )

        var warnings: [String] = []
        do {
            try await applyTag(tagID, toIssue: created.id, named: tagName, credentials: credentials)
        } catch {
            warnings.append("The \(tagName) tag could not be applied.")
        }
        if let imagePNG = feedback.imagePNG {
            do {
                try await attach(
                    [AttachmentFile(fileName: Self.feedbackImageFileName, contentType: "image/png", data: imagePNG)],
                    toIssue: created.id, deniedAction: "attach the window image", credentials: credentials
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

    /// Looked up before the tag, so an unreadable NIT leaves no tag behind.
    private func feedbackProject(with credentials: (instanceURL: URL, token: String)) async throws -> YouTrackProject {
        let shortName = Self.feedbackProjectShortName
        do {
            let project: FeedbackProjectPayload = try await requestYouTrack(
                instanceURL: credentials.instanceURL, token: credentials.token,
                path: "api/admin/projects/\(shortName)", query: "fields=id,name",
                deniedAction: "read the \(shortName) project"
            )
            return YouTrackProject(id: project.id, shortName: shortName, name: project.name)
        } catch YouTrackError.unexpectedResponse(statusCode: 404) {
            throw YouTrackError.projectNotFound(shortName: shortName)
        }
    }
}

// MARK: - Wire payloads

private struct FeedbackProjectPayload: Decodable {
    var id: String
    var name: String
}
