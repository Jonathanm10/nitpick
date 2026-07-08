import Foundation

/// The YouTrack issue a Finding became — what the designer sees after filing.
public struct FiledIssue: Equatable, Sendable, Codable {
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
    /// screenshot and the clean original — and two tags applied:
    /// `design-review` and the Finding's `nitpick-type:*` (ADR-0008). The
    /// session supplies the project — chosen once at session start, never
    /// re-asked.
    public func file(_ finding: Finding, in session: ReviewSession) async throws -> FiledIssue {
        guard !finding.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw YouTrackError.summaryRequired
        }
        guard let credentials = try savedYouTrackCredentials() else { throw YouTrackError.notConnected }

        // Flatten before anything reaches the network: Annotations freeze
        // into the attached image at this moment — the moment editability
        // ends — and a rendering failure leaves no orphan issue behind.
        let annotatedPNG = try finding.annotatedScreenshotPNG()

        // Resolve both tags before creating anything: tag creation needs its
        // own permission, and a refusal here must not leave an orphan issue.
        let designReviewTagID = try await tagID(named: Self.designReviewTagName, with: credentials)
        let typeTagID = try await tagID(named: finding.type.tagName, with: credentials)

        var item = TrayItem(finding: finding)
        while true {
            if case .filed(let issue) = item.filingProgress { return issue }
            try await advanceFilingOneStep(
                of: &item, in: session,
                annotatedPNG: annotatedPNG, credentials: credentials,
                designReviewTagID: designReviewTagID, typeTagID: typeTagID
            )
        }
    }

    /// Files every not-yet-filed tray item in capture order — one issue per
    /// Finding (PRD story 24). Failure-safe and crash-safe: each item's
    /// ladder records every server-acknowledged step on the tray AND on
    /// disk before the next request fires, so a transport failure — or the
    /// app dying mid-run — loses nothing. Filed items stay marked,
    /// untouched Findings stay editable, and retrying (even after a
    /// relaunch) resumes exactly where the run stopped instead of
    /// re-filing. When the whole tray has filed, the session leaves the
    /// open slot and becomes a read-only history entry.
    public func fileAll(
        in session: ReviewSession,
        onProgress: (@MainActor @Sendable (ReviewSession) -> Void)? = nil
    ) async -> FileAllOutcome {
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
            // Resolve every tag before any issue exists — the same
            // orphan-avoidance as single filing. design-review is shared by
            // every item; each distinct Finding Type contributes its own
            // `nitpick-type:*` tag, resolved in a stable order so a mixed
            // Bug/Improvement run emits deterministic requests (ADR-0008).
            let designReviewTagID = try await tagID(named: Self.designReviewTagName, with: credentials)
            var typeTagIDs: [String: String] = [:]
            for name in Set(pending.map { updated.tray[$0.index].finding.type.tagName }).sorted() {
                typeTagIDs[name] = try await tagID(named: name, with: credentials)
            }
            for (index, annotatedPNG) in pending {
                while updated.tray[index].filedIssue == nil {
                    try await advanceFilingOneStep(
                        of: &updated.tray[index], in: session,
                        annotatedPNG: annotatedPNG, credentials: credentials,
                        designReviewTagID: designReviewTagID,
                        typeTagID: typeTagIDs[updated.tray[index].finding.type.tagName]!
                    )
                    // Durability (issue 07): the mark hits disk before the
                    // next request fires — a crash mid-run resumes on
                    // relaunch, never re-files.
                    try saveOpenSession(updated)
                }
                if let onProgress {
                    await onProgress(updated)
                }
            }
            // Every tray item is filed: freeze the session into history
            // and clear the open slot.
            try recordInHistory(updated)
            return FileAllOutcome(session: updated, failure: nil)
        } catch {
            return FileAllOutcome(session: updated, failure: error)
        }
    }

    /// Advances one tray item's filing ladder by exactly one rung — create
    /// the issue, attach both screenshot variants, apply the `design-review`
    /// tag, or apply the `nitpick-type:*` tag — recording the
    /// server-acknowledged step on the item. On a throw the item keeps the
    /// last recorded step, which is what makes filing resumable: a retry
    /// repeats nothing the instance already acknowledged. A no-op on an
    /// already-filed item. Both tag IDs are resolved before the first rung,
    /// so this step never creates a tag — it only applies one.
    private func advanceFilingOneStep(
        of item: inout TrayItem,
        in session: ReviewSession,
        annotatedPNG: Data,
        credentials: (instanceURL: URL, token: String),
        designReviewTagID: String,
        typeTagID: String
    ) async throws {
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
            // The description just rendered used the effective Design
            // Reference (Finding override, else session-level). Freeze it
            // onto the Finding now that the issue exists: the tray record —
            // persisted, and later the history entry — must never diverge
            // from what the issue says, even if the session-level reference
            // changes before a retry files the remainder. On a throw the
            // Finding stays untouched and editable.
            item.finding.designReference = session.effectiveDesignReference(for: item.finding)
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
            try await applyTag(designReviewTagID, toIssue: issueID, named: Self.designReviewTagName, credentials: credentials)
            item.filingProgress = .reviewTagged(issueID: issueID, idReadable: idReadable)

        case .reviewTagged(let issueID, let idReadable):
            // The Type tag rides last, one tag per request (ADR-0008): the
            // issue is already review-tagged, so a failure here resumes at
            // this rung alone and never re-applies design-review.
            try await applyTag(typeTagID, toIssue: issueID, named: item.finding.type.tagName, credentials: credentials)
            item.filingProgress = .filed(FiledIssue(
                idReadable: idReadable,
                url: credentials.instanceURL
                    .appendingPathComponent("issue")
                    .appendingPathComponent(idReadable)
            ))

        case .filed:
            break
        }
    }

    /// Applies one already-resolved tag to an issue — one tag per request,
    /// so each application is its own recorded ladder step.
    private func applyTag(
        _ tagID: String,
        toIssue issueID: String,
        named name: String,
        credentials: (instanceURL: URL, token: String)
    ) async throws {
        let _: TagPayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues/\(issueID)/tags", query: "fields=id,name",
            body: try Self.jsonBody(TagReference(id: tagID)),
            deniedAction: "apply the “\(name)” tag"
        )
    }

    /// The instance-side ID of a tag by exact name: found among the tags
    /// visible to the designer, or created on first use. Used for both the
    /// fixed `design-review` tag and each Finding's `nitpick-type:*` tag —
    /// resolved before any issue is created, so a create-permission refusal
    /// never leaves an orphan issue behind (ADR-0008).
    private func tagID(
        named name: String,
        with credentials: (instanceURL: URL, token: String)
    ) async throws -> String {
        // `query=` filters server-side by name; the exact-match check drops
        // lookalikes ("design-review-old", "nitpick-type:bugfix").
        let candidates: [TagPayload] = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            path: "api/tags", query: "fields=id,name&query=\(name)&$top=100",
            deniedAction: "list tags"
        )
        if let existing = candidates.first(where: { $0.name == name }) {
            return existing.id
        }
        let created: TagPayload = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/tags", query: "fields=id,name",
            body: try Self.jsonBody(TagCreationPayload(name: name)),
            deniedAction: "create the “\(name)” tag (it does not exist yet)"
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
