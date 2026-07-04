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

/// What a file-all run left behind. Progress is never thrown away: the
/// returned session carries every mark the run made, finished or not.
public struct FileAllOutcome: Sendable {
    /// The session with every step the run completed recorded on its tray.
    public var session: ReviewSession
    /// nil when every remaining tray item filed; otherwise the error that
    /// stopped the run. Retrying `fileAll` with the returned session files
    /// only what is still missing.
    public var failure: (any Error)?
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
        guard !finding.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw YouTrackError.summaryRequired
        }
        guard let credentials = try savedYouTrackCredentials() else { throw YouTrackError.notConnected }

        // Flatten before anything reaches the network: Annotations freeze
        // into the attached image at this moment — the moment editability
        // ends — and a rendering failure leaves no orphan issue behind.
        let annotatedPNG = try finding.annotatedScreenshotPNG()

        // Resolve the tag before creating anything: tag creation needs its
        // own permission, and a refusal here must not leave an orphan issue.
        let tagID = try await designReviewTagID(with: credentials)

        var item = TrayItem(finding: finding)
        return try await advanceFiling(
            of: &item, in: session,
            annotatedPNG: annotatedPNG, credentials: credentials, tagID: tagID
        )
    }

    /// Files every not-yet-filed tray item in capture order — one issue per
    /// Finding (PRD story 24). Failure-safe: each item's ladder records
    /// every server-acknowledged step before the next request fires, so a
    /// transport failure mid-run loses nothing — filed items stay marked,
    /// untouched Findings stay editable, and retrying resumes exactly where
    /// the run stopped instead of re-filing.
    public func fileAll(in session: ReviewSession) async -> FileAllOutcome {
        var updated = session
        let remaining = updated.tray.indices.filter { updated.tray[$0].filedIssue == nil }
        guard !remaining.isEmpty else { return FileAllOutcome(session: updated, failure: nil) }
        do {
            guard let credentials = try savedYouTrackCredentials() else { throw YouTrackError.notConnected }
            // Validate and flatten every remaining Finding before the first
            // request: a missing summary or an undecodable capture on the
            // last item must stop the run before it half-files the tray.
            var pending: [(index: Int, annotatedPNG: Data)] = []
            for index in remaining {
                let item = updated.tray[index]
                if item.isEditable,
                    item.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    throw YouTrackError.summaryRequired
                }
                pending.append((index, try item.finding.annotatedScreenshotPNG()))
            }
            // One tag resolution per run, before any issue exists — the
            // same orphan-avoidance as single filing, shared by every item.
            let tagID = try await designReviewTagID(with: credentials)
            for (index, annotatedPNG) in pending {
                try await advanceFiling(
                    of: &updated.tray[index], in: session,
                    annotatedPNG: annotatedPNG, credentials: credentials, tagID: tagID
                )
            }
            return FileAllOutcome(session: updated, failure: nil)
        } catch {
            return FileAllOutcome(session: updated, failure: error)
        }
    }

    /// Advances one tray item's filing ladder from wherever it stands —
    /// create the issue, attach both screenshot variants, apply the
    /// design-review tag — recording each server-acknowledged step on the
    /// item before the next request fires. On a throw the item keeps the
    /// last recorded step, which is what makes filing resumable: a retry
    /// repeats nothing the instance already acknowledged.
    @discardableResult
    private func advanceFiling(
        of item: inout TrayItem,
        in session: ReviewSession,
        annotatedPNG: Data,
        credentials: (instanceURL: URL, token: String),
        tagID: String
    ) async throws -> FiledIssue {
        while true {
            switch item.filingProgress {
            case .notStarted:
                let issue: CreatedIssuePayload = try await requestYouTrack(
                    instanceURL: credentials.instanceURL, token: credentials.token,
                    method: "POST", path: "api/issues", query: "fields=id,idReadable",
                    body: try Self.jsonBody(IssueCreationPayload(
                        project: .init(id: session.project.id),
                        summary: item.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines),
                        description: session.issueDescription(for: item.finding)
                    )),
                    deniedAction: "create an issue in \(session.project.name)"
                )
                item.filingProgress = .issueCreated(issueID: issue.id, idReadable: issue.idReadable)

            case .issueCreated(let issueID, let idReadable):
                // Attach before tagging: if attaching fails, the issue stays
                // untagged — invisible to the v2 verify pass and the
                // review-backlog query — rather than tagged but missing its
                // screenshots. Both variants ride one request: annotated
                // first, clean original second (PRD story 29).
                let _: [AttachmentPayload] = try await requestYouTrack(
                    instanceURL: credentials.instanceURL, token: credentials.token,
                    method: "POST", path: "api/issues/\(issueID)/attachments", query: "fields=id,name",
                    body: Self.attachmentsBody([
                        (fileName: "annotated.png", data: annotatedPNG),
                        (fileName: "original.png", data: item.finding.screenshotPNG),
                    ]),
                    deniedAction: "attach the screenshots"
                )
                item.filingProgress = .attachmentsUploaded(issueID: issueID, idReadable: idReadable)

            case .attachmentsUploaded(let issueID, let idReadable):
                let _: TagPayload = try await requestYouTrack(
                    instanceURL: credentials.instanceURL, token: credentials.token,
                    method: "POST", path: "api/issues/\(issueID)/tags", query: "fields=id,name",
                    body: try Self.jsonBody(TagReference(id: tagID)),
                    deniedAction: "apply the “\(Self.designReviewTagName)” tag"
                )
                item.filingProgress = .filed(FiledIssue(
                    idReadable: idReadable,
                    url: credentials.instanceURL
                        .appendingPathComponent("issue")
                        .appendingPathComponent(idReadable)
                ))

            case .filed(let issue):
                return issue
            }
        }
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
