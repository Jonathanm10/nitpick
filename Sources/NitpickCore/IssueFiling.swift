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

/// A triage field the create step could not set (glossary: Priority,
/// Assignee) — reported so the shell can toast the designer the value to
/// relay by hand (ADR-0008). Best-effort: the Finding still files. Never
/// persisted — History and `FiledIssue` are unchanged.
public struct DroppedTriageField: Equatable, Sendable {
    public enum Field: String, Equatable, Sendable, CaseIterable {
        case priority
        case assignee

        /// The designer-facing field name, for the toast.
        public var label: String {
            switch self {
            case .priority: "Priority"
            case .assignee: "Assignee"
            }
        }
    }

    public var field: Field
    /// The value the designer intended, in human-readable form.
    public var intendedValue: String

    public init(field: Field, intendedValue: String) {
        self.field = field
        self.intendedValue = intendedValue
    }
}

/// What single filing left behind: the filed issue, plus any optional
/// triage fields the create had to drop.
public struct FilingResult: Equatable, Sendable {
    public var issue: FiledIssue
    public var droppedFields: [DroppedTriageField]

    public init(issue: FiledIssue, droppedFields: [DroppedTriageField] = []) {
        self.issue = issue
        self.droppedFields = droppedFields
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
    /// Per tray item (keyed by its identity, never the Finding — byte-equal
    /// captures stay distinct), the optional triage fields the create had to
    /// drop. Empty for a clean run; transient, never persisted.
    public var droppedFields: [TrayItem.ID: [DroppedTriageField]] = [:]
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
    public func file(_ finding: Finding, in session: ReviewSession) async throws -> FilingResult {
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
        var dropped: [DroppedTriageField] = []
        while true {
            if case .filed(let issue) = item.filingProgress {
                return FilingResult(issue: issue, droppedFields: dropped)
            }
            dropped += try await advanceFilingOneStep(
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
        var droppedFields: [TrayItem.ID: [DroppedTriageField]] = [:]
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
                    let stepDropped = try await advanceFilingOneStep(
                        of: &updated.tray[index], in: session,
                        annotatedPNG: annotatedPNG, credentials: credentials,
                        designReviewTagID: designReviewTagID,
                        typeTagID: typeTagIDs[updated.tray[index].finding.type.tagName]!
                    )
                    if !stepDropped.isEmpty {
                        droppedFields[updated.tray[index].id, default: []] += stepDropped
                    }
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
            return FileAllOutcome(session: updated, failure: nil, droppedFields: droppedFields)
        } catch {
            return FileAllOutcome(session: updated, failure: error, droppedFields: droppedFields)
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
    ) async throws -> [DroppedTriageField] {
        switch item.filingProgress {
        case .notStarted:
            let created = try await createIssue(item.finding, in: session, credentials: credentials)
            // The description just rendered used the effective Design
            // Reference (Finding override, else session-level). Freeze it
            // onto the Finding now that the issue exists: the tray record —
            // persisted, and later the history entry — must never diverge
            // from what the issue says, even if the session-level reference
            // changes before a retry files the remainder. On a throw the
            // Finding stays untouched and editable.
            item.finding.designReference = session.effectiveDesignReference(for: item.finding)
            item.filingProgress = .issueCreated(issueID: created.issue.id, idReadable: created.issue.idReadable)
            return created.droppedFields

        case .issueCreated(let issueID, let idReadable):
            // Attach before tagging: if attaching fails, the issue stays
            // untagged — invisible to the v2 verify pass and the
            // review-backlog query — rather than tagged but missing its
            // screenshots. Both variants ride one request: annotated
            // first, clean original second (PRD story 29).
            let snapshots = item.finding.designSnapshots
            let attachmentNames = snapshots.effectiveAttachmentNames(reserving: ["annotated.png", "original.png"])
            let designSnapshots = zip(snapshots, attachmentNames).map { snapshot, attachmentName in
                AttachmentFile(
                    fileName: attachmentName,
                    contentType: snapshot.mediaType.contentType,
                    data: snapshot.data
                )
            }
            try await attach(
                [
                    AttachmentFile(fileName: "annotated.png", contentType: "image/png", data: annotatedPNG),
                    AttachmentFile(fileName: "original.png", contentType: "image/png", data: item.finding.screenshotPNG),
                ] + designSnapshots,
                toIssue: issueID, deniedAction: "attach the screenshots", credentials: credentials
            )
            item.filingProgress = .attachmentsUploaded(issueID: issueID, idReadable: idReadable)
            return []

        case .attachmentsUploaded(let issueID, let idReadable):
            try await applyTag(designReviewTagID, toIssue: issueID, named: Self.designReviewTagName, credentials: credentials)
            item.filingProgress = .reviewTagged(issueID: issueID, idReadable: idReadable)
            return []

        case .reviewTagged(let issueID, let idReadable):
            // The Type tag rides last, one tag per request (ADR-0008): the
            // issue is already review-tagged, so a failure here resumes at
            // this rung alone and never re-applies design-review.
            try await applyTag(typeTagID, toIssue: issueID, named: item.finding.type.tagName, credentials: credentials)
            item.filingProgress = .filed(FiledIssue(
                idReadable: idReadable,
                url: Self.issueURL(instanceURL: credentials.instanceURL, idReadable: idReadable)
            ))
            return []

        case .filed:
            return []
        }
    }

    /// Creates the issue, carrying the Finding's optional triage custom
    /// fields (Priority/Assignee) in the body — finalized before
    /// `.issueCreated`, so no new ladder rung. Best-effort on those fields:
    /// summary and project are already validated, so a 400 rejection while
    /// custom fields were sent is attributable to them — the create is
    /// retried exactly once *without* the optional fields (summary,
    /// description, project preserved), the Finding still files, and the
    /// dropped fields are reported. If the retry-without-fields still fails,
    /// that error propagates: a genuine failure is never masked. Auth (401/
    /// 403), network, and project-gone (404) failures are never retried
    /// (ADR-0008).
    private func createIssue(
        _ finding: Finding,
        in session: ReviewSession,
        credentials: (instanceURL: URL, token: String)
    ) async throws -> (issue: CreatedIssuePayload, droppedFields: [DroppedTriageField]) {
        let customFields = Self.customFields(for: finding)
        let summary = finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let description = session.issueDescription(for: finding)
        func create(withCustomFields fields: [IssueCustomField]?) async throws -> CreatedIssuePayload {
            try await createIssue(
                in: session.project, summary: summary, description: description,
                customFields: fields, credentials: credentials
            )
        }
        do {
            return (try await create(withCustomFields: customFields.isEmpty ? nil : customFields), [])
        } catch {
            guard !customFields.isEmpty, Self.isCustomFieldRejection(error) else { throw error }
            return (try await create(withCustomFields: nil), Self.droppedFields(for: finding))
        }
    }

    /// A create rejection the optional custom fields could be responsible
    /// for: a 400. Auth (401/403 → tokenRejected/permissionDenied), network
    /// (URLError), and project-gone (404 → unexpectedResponse) never match.
    private static func isCustomFieldRejection(_ error: any Error) -> Bool {
        if case YouTrackError.unexpectedResponse(let statusCode) = error { return statusCode == 400 }
        return false
    }

    /// The Finding's optional triage custom fields, in a fixed order
    /// (Priority before Assignee) so create bodies stay byte-stable.
    private static func customFields(for finding: Finding) -> [IssueCustomField] {
        var fields: [IssueCustomField] = []
        if let priority = finding.priority {
            fields.append(IssueCustomField(
                type: "SingleEnumIssueCustomField", name: "Priority",
                value: .enumValue(name: priority.name)
            ))
        }
        if let assignee = finding.assignee {
            fields.append(IssueCustomField(
                type: "SingleUserIssueCustomField", name: "Assignee",
                value: .user(login: assignee.login)
            ))
        }
        return fields
    }

    /// The triage fields a create dropped, paired with the values the
    /// designer intended — what the shell toasts.
    private static func droppedFields(for finding: Finding) -> [DroppedTriageField] {
        var dropped: [DroppedTriageField] = []
        if let priority = finding.priority {
            dropped.append(DroppedTriageField(field: .priority, intendedValue: priority.name))
        }
        if let assignee = finding.assignee {
            dropped.append(DroppedTriageField(field: .assignee, intendedValue: assignee.fullName))
        }
        return dropped
    }
}
