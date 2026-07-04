import Foundation

/// The YouTrack issue a Finding became — what the designer sees after filing.
public struct FiledIssue: Equatable, Sendable {
    /// The human-readable issue ID, e.g. "RM-421".
    public var idReadable: String
    /// The issue's page on the instance.
    public var url: URL

    public init(idReadable: String, url: URL) {
        self.idReadable = idReadable
        self.url = url
    }
}

extension AppCore {
    /// The fixed tag every nitpick-filed issue carries — the query key for
    /// the review backlog (PRD story 32) and for the v2 verify pass
    /// (ADR-0004).
    public static let designReviewTagName = "design-review"

    /// Files one Finding as exactly one YouTrack issue, authored by the
    /// token's user: the designer's summary, the designer's description with
    /// the metadata block appended, two attachments — the annotated
    /// screenshot and the clean original — and the design-review tag
    /// applied. The session supplies the project — chosen once at session
    /// start, never re-asked.
    public func file(_ finding: Finding, in session: ReviewSession) async throws -> FiledIssue {
        let summary = finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !summary.isEmpty else { throw YouTrackError.summaryRequired }
        guard let credentials = try savedYouTrackCredentials() else { throw YouTrackError.notConnected }

        // Flatten before anything reaches the network: Annotations freeze
        // into the attached image at this moment — the moment editability
        // ends — and a rendering failure leaves no orphan issue behind.
        let annotatedPNG = try finding.annotatedScreenshotPNG()

        // Resolve the tag before creating anything: tag creation needs its
        // own permission, and a refusal here must not leave an orphan issue.
        let tagID = try await designReviewTagID(with: credentials)

        let issue: CreatedIssuePayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues", query: "fields=id,idReadable",
            body: try Self.jsonBody(IssueCreationPayload(
                project: .init(id: session.project.id),
                summary: summary,
                description: session.issueDescription(for: finding)
            )),
            deniedAction: "create an issue in \(session.project.name)"
        )

        // Attach before tagging: if attaching fails, the issue stays
        // untagged — invisible to the v2 verify pass and the review-backlog
        // query — rather than tagged but missing its screenshots. Both
        // variants ride one request: annotated first, clean original second
        // (PRD story 29).
        let _: [AttachmentPayload] = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues/\(issue.id)/attachments", query: "fields=id,name",
            body: Self.attachmentsBody([
                (fileName: "annotated.png", data: annotatedPNG),
                (fileName: "original.png", data: finding.screenshotPNG),
            ]),
            deniedAction: "attach the screenshots"
        )

        let _: TagPayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues/\(issue.id)/tags", query: "fields=id,name",
            body: try Self.jsonBody(TagReference(id: tagID)),
            deniedAction: "apply the “\(Self.designReviewTagName)” tag"
        )

        return FiledIssue(
            idReadable: issue.idReadable,
            url: credentials.instanceURL
                .appendingPathComponent("issue")
                .appendingPathComponent(issue.idReadable)
        )
    }

    /// The instance-side ID of the design-review tag: found among the tags
    /// visible to the designer, or created on first use.
    private func designReviewTagID(
        with credentials: (instanceURL: URL, token: String)
    ) async throws -> String {
        // `query=` filters server-side by name; the exact-match check drops
        // lookalikes ("design-review-old").
        let candidates: [TagPayload] = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            path: "api/tags", query: "fields=id,name&query=\(Self.designReviewTagName)&$top=100",
            deniedAction: "list tags"
        )
        if let existing = candidates.first(where: { $0.name == Self.designReviewTagName }) {
            return existing.id
        }
        let created: TagPayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/tags", query: "fields=id,name",
            body: try Self.jsonBody(TagCreationPayload(name: Self.designReviewTagName)),
            deniedAction: "create the “\(Self.designReviewTagName)” tag (it does not exist yet)"
        )
        return created.id
    }

    // MARK: - Request bodies

    /// Deterministic JSON: sorted keys make bodies byte-stable for the
    /// request-shape tests; slashes stay readable.
    private static func jsonBody(_ payload: some Encodable) throws -> (contentType: String, data: Data) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (contentType: "application/json", data: try encoder.encode(payload))
    }

    /// The multipart/form-data body YouTrack's attachments endpoint expects:
    /// one `upload` part per attached file.
    private static func attachmentsBody(
        _ files: [(fileName: String, data: Data)]
    ) -> (contentType: String, data: Data) {
        let boundary = "nitpick-\(UUID().uuidString)"
        var body = Data()
        // Explicit escapes: every line break in a multipart body is CRLF,
        // and the blank line separating headers from content is exactly
        // one \r\n — nothing implicit.
        for file in files {
            body.append(contentsOf: Data((
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data; name=\"upload\"; filename=\"\(file.fileName)\"\r\n"
                    + "Content-Type: image/png\r\n"
                    + "\r\n"
            ).utf8))
            body.append(file.data)
            body.append(contentsOf: Data("\r\n".utf8))
        }
        body.append(contentsOf: Data("--\(boundary)--\r\n".utf8))
        return (contentType: "multipart/form-data; boundary=\(boundary)", data: body)
    }
}

// MARK: - Wire payloads

private struct IssueCreationPayload: Encodable {
    struct ProjectReference: Encodable {
        var id: String
    }

    var project: ProjectReference
    var summary: String
    var description: String
}

private struct TagCreationPayload: Encodable {
    var name: String
}

private struct TagReference: Encodable {
    var id: String
}

/// The subset of `POST api/issues` the core reads back.
private struct CreatedIssuePayload: Decodable {
    var id: String
    var idReadable: String
}

/// The subset of tag payloads the core reads.
private struct TagPayload: Decodable {
    var id: String
    var name: String
}

/// The subset of `POST api/issues/{id}/attachments` the core reads back.
private struct AttachmentPayload: Decodable {
    var id: String
    var name: String
}
