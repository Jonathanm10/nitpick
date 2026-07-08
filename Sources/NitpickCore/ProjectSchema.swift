import Foundation

/// The triage options a project offers, read once at session setup where
/// the Build and project are already fixed (ADR-0008). The Editor's
/// Priority control is populated from this; an empty list hides the
/// control. Held in memory for the session — never persisted per Finding.
public struct ProjectSchema: Equatable, Sendable {
    /// The project's Priority scale, in the project's own order. Empty when
    /// the project has no Priority field or the read failed.
    public var priorities: [FindingPriority]

    public init(priorities: [FindingPriority] = []) {
        self.priorities = priorities
    }
}

extension AppCore {
    /// Reads the chosen project's triage schema — its Priority scale — once
    /// at session setup. Deliberately **non-fatal**: any failure (offline,
    /// no permission, no Priority field) yields an empty schema so the
    /// Review Session still starts and the Editor simply hides the control
    /// (PRD story 22). Type is nitpick-owned and never read here.
    public func loadProjectSchema(for project: YouTrackProject) async -> ProjectSchema {
        do {
            guard let credentials = try savedYouTrackCredentials() else { return ProjectSchema() }
            let fields: [ProjectCustomFieldPayload] = try await requestYouTrack(
                instanceURL: credentials.instanceURL, token: credentials.token,
                path: "api/admin/projects/\(project.id)/customFields",
                query: "fields=field(name),bundle(values(name))&$top=100"
            )
            let priorities = (fields.first { $0.field?.name == "Priority" }?.bundle?.values ?? [])
                .compactMap(\.name)
                .map(FindingPriority.init(name:))
            return ProjectSchema(priorities: priorities)
        } catch {
            return ProjectSchema()
        }
    }
}

/// The subset of `ProjectCustomField` the schema read consumes: the field's
/// name plus, for a bundle-backed field, its values. `bundle` is null on
/// non-bundle fields; every property is optional so a partial or unexpected
/// payload degrades to an empty schema rather than throwing.
struct ProjectCustomFieldPayload: Decodable {
    struct FieldReference: Decodable {
        var name: String?
    }

    struct Bundle: Decodable {
        var values: [BundleValue]?
    }

    var field: FieldReference?
    var bundle: Bundle?
}

/// One value of a bundle-backed field — an enum option's name (a Priority
/// value here).
struct BundleValue: Decodable {
    var name: String?
}
