import Foundation

/// Tag resolution and application, shared by every path that tags an Issue:
/// Finding filing (`design-review`, `nitpick-type:*`) and Feedback
/// (`nitpick-feedback:*`). One implementation keeps the exact-name matching
/// and the resolve-before-create ordering identical for both (ADR-0008).
extension AppCore {
    /// Applies one already-resolved tag to an issue — one tag per request,
    /// so each application is its own recorded ladder step.
    func applyTag(
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
    /// visible to the designer, or created on first use. Callers resolve
    /// every tag before any issue is created, so a create-permission refusal
    /// never leaves an orphan issue behind (ADR-0008).
    func tagID(
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
}

// MARK: - Wire payloads

private struct TagCreationPayload: Encodable {
    var name: String
}

private struct TagReference: Encodable {
    var id: String
}

/// The subset of tag payloads the core reads.
private struct TagPayload: Decodable {
    var id: String
    var name: String
}
