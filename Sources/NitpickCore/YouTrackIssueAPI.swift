import Foundation

/// The issue endpoints Finding filing and Feedback share: create an issue,
/// attach files, resolve and apply tags.
extension AppCore {
    func createIssue(
        in project: YouTrackProject,
        summary: String,
        description: String,
        customFields: [IssueCustomField]? = nil,
        credentials: (instanceURL: URL, token: String)
    ) async throws -> CreatedIssuePayload {
        try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues", query: "fields=id,idReadable",
            body: try Self.jsonBody(IssueCreationPayload(
                customFields: customFields, project: .init(id: project.id),
                summary: summary, description: description
            )),
            deniedAction: "create an issue in \(project.name)"
        )
    }

    /// One request, one `upload` part per file, in the given order.
    func attach(
        _ files: [AttachmentFile],
        toIssue issueID: String,
        deniedAction: String,
        credentials: (instanceURL: URL, token: String)
    ) async throws {
        let _: [AttachmentPayload] = try await requestYouTrack(
            instanceURL: credentials.instanceURL, token: credentials.token,
            method: "POST", path: "api/issues/\(issueID)/attachments", query: "fields=id,name",
            body: Self.attachmentsBody(files),
            deniedAction: deniedAction
        )
    }

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

    /// Callers resolve every tag before any issue is created, so a
    /// create-permission refusal never leaves an orphan issue (ADR-0008).
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

    static func issueURL(instanceURL: URL, idReadable: String) -> URL {
        instanceURL
            .appendingPathComponent("issue")
            .appendingPathComponent(idReadable)
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
        _ files: [AttachmentFile]
    ) -> (contentType: String, data: Data) {
        let boundary = "nitpick-\(UUID().uuidString)"
        var body = Data()
        // Explicit escapes: every line break in a multipart body is CRLF,
        // and the blank line separating headers from content is exactly
        // one \r\n — nothing implicit.
        for file in files {
            let quotedFileName = file.fileName
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\r", with: " ")
                .replacingOccurrences(of: "\n", with: " ")
            body.append(contentsOf: Data((
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data; name=\"upload\"; filename=\"\(quotedFileName)\"\r\n"
                    + "Content-Type: \(file.contentType)\r\n"
                    + "\r\n"
            ).utf8))
            body.append(file.data)
            body.append(contentsOf: Data("\r\n".utf8))
        }
        body.append(contentsOf: Data("--\(boundary)--\r\n".utf8))
        return (contentType: "multipart/form-data; boundary=\(boundary)", data: body)
    }
}

struct AttachmentFile {
    var fileName: String
    var contentType: String
    var data: Data
}

// MARK: - Wire payloads

private struct IssueCreationPayload: Encodable {
    struct ProjectReference: Encodable {
        var id: String
    }

    /// Optional triage custom fields (Priority/Assignee). Nil omits the key
    /// entirely — a Finding with no triage fields files exactly the body it
    /// always did, byte-for-byte (ADR-0008). Feedback never sends any.
    var customFields: [IssueCustomField]?
    var project: ProjectReference
    var summary: String
    var description: String
}

/// A custom field on the issue-creation body: Priority as an enum value
/// name, Assignee as a user login. `$type` names the YouTrack field kind;
/// with sorted keys this encodes as {"$type":…,"name":…,"value":{…}}.
struct IssueCustomField: Encodable {
    enum Value: Encodable {
        case enumValue(name: String)
        case user(login: String)

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CustomFieldValueKey.self)
            switch self {
            case .enumValue(let name): try container.encode(name, forKey: .name)
            case .user(let login): try container.encode(login, forKey: .login)
            }
        }
    }

    var type: String
    var name: String
    var value: Value

    enum CodingKeys: String, CodingKey {
        case type = "$type"
        case name
        case value
    }
}

private enum CustomFieldValueKey: String, CodingKey {
    case name
    case login
}

/// The subset of `POST api/issues` the core reads back.
struct CreatedIssuePayload: Decodable {
    var id: String
    var idReadable: String
}

/// The subset of `POST api/issues/{id}/attachments` the core reads back.
private struct AttachmentPayload: Decodable {
    var id: String
    var name: String
}

private struct TagCreationPayload: Encodable {
    var name: String
}

private struct TagReference: Encodable {
    var id: String
}

private struct TagPayload: Decodable {
    var id: String
    var name: String
}
