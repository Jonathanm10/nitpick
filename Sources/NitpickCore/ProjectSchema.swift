import Foundation

/// The triage options a project offers, read once at session setup where
/// the Build and project are already fixed (ADR-0008). The Editor's
/// Priority and Assignee controls are populated from this; an empty list
/// hides the matching control. Held in memory for the session — never
/// persisted per Finding.
public struct ProjectSchema: Equatable, Sendable {
    /// The project's Priority scale, in the project's own order. Empty when
    /// the project has no Priority field or the read failed.
    public var priorities: [FindingPriority]
    /// The project's assignable users. Empty when the project has no
    /// assignable users or the read failed.
    public var assignees: [FindingAssignee]

    public init(priorities: [FindingPriority] = [], assignees: [FindingAssignee] = []) {
        self.priorities = priorities
        self.assignees = assignees
    }
}

extension AppCore {
    /// Reads the chosen project's triage schema — its Priority scale and
    /// assignable users — once at session setup. Deliberately **non-fatal**:
    /// any failure (offline, no permission, no Priority field, no assignable
    /// users) yields an empty schema so the Review Session still starts and
    /// the Editor simply hides the affected control (PRD story 22). Type is
    /// nitpick-owned and never read here.
    public func loadProjectSchema(for project: YouTrackProject) async -> ProjectSchema {
        do {
            guard let credentials = try savedYouTrackCredentials() else { return ProjectSchema() }
            let fields: [ProjectCustomFieldPayload] = try await requestYouTrack(
                instanceURL: credentials.instanceURL, token: credentials.token,
                path: "api/admin/projects/\(project.id)/customFields",
                query: "fields=field(name),bundle(values(name),aggregatedUsers(login,fullName))&$top=100"
            )
            let priorities = (fields.first { $0.field?.name == "Priority" }?.bundle?.values ?? [])
                .compactMap(\.name)
                .map(FindingPriority.init(name:))
            let assignees = (fields.first { $0.field?.name == "Assignee" }?.bundle?.aggregatedUsers ?? [])
                .compactMap { user in user.login.map { FindingAssignee(login: $0, fullName: user.fullName ?? $0) } }
            return ProjectSchema(priorities: priorities, assignees: assignees)
        } catch {
            return ProjectSchema()
        }
    }
}

/// The subset of `ProjectCustomField` the schema read consumes: the field's
/// name plus, for a bundle-backed field, its values (an enum bundle) or its
/// aggregated users (a user bundle). `bundle` is null on non-bundle fields;
/// every property is optional so a partial or unexpected payload degrades to
/// an empty schema rather than throwing.
struct ProjectCustomFieldPayload: Decodable {
    struct FieldReference: Decodable {
        var name: String?
    }

    struct Bundle: Decodable {
        var values: [BundleValue]?
        var aggregatedUsers: [BundleUser]?
    }

    var field: FieldReference?
    var bundle: Bundle?
}

/// One value of an enum bundle — an option's name (a Priority value here).
struct BundleValue: Decodable {
    var name: String?
}

/// One assignable user of a user bundle — the Assignee field's members.
/// `fullName` is nullable server-side; the picker falls back to the login.
struct BundleUser: Decodable {
    var login: String?
    var fullName: String?
}
