import Foundation

/// The designer's YouTrack identity — the user filed issues will be
/// authored as.
public struct YouTrackUser: Equatable, Sendable {
    public var login: String
    public var fullName: String

    public init(login: String, fullName: String) {
        self.login = login
        self.fullName = fullName
    }
}

/// A YouTrack project a Review Session can file Findings into.
public struct YouTrackProject: Equatable, Sendable, Identifiable {
    /// YouTrack's entity id, e.g. "0-12" — what the issues API references.
    public var id: String
    /// The key issue IDs derive from, e.g. "RM" in RM-421.
    public var shortName: String
    public var name: String

    public init(id: String, shortName: String, name: String) {
        self.id = id
        self.shortName = shortName
        self.name = name
    }
}

/// A verified YouTrack connection: who issues will be authored as, and
/// where they can be filed.
public struct YouTrackConnection: Equatable, Sendable {
    public var user: YouTrackUser
    /// Projects visible to the designer, sorted by name.
    public var projects: [YouTrackProject]

    public init(user: YouTrackUser, projects: [YouTrackProject]) {
        self.user = user
        self.projects = projects
    }
}

/// The YouTrack connection failed in a way the designer can act on.
public enum YouTrackError: Error, Equatable, LocalizedError {
    /// The entered instance URL cannot be parsed into an http(s) URL.
    case invalidInstanceURL(entered: String)
    /// An http:// URL beyond loopback would send the permanent token in
    /// cleartext.
    case insecureInstanceURL(entered: String)
    /// The server answered 401/403: the token is wrong, revoked, or expired.
    case tokenRejected
    /// The server answered, but not with YouTrack-shaped JSON — the URL
    /// likely points at something else.
    case notAYouTrackInstance(url: String)
    /// Any other non-success status.
    case unexpectedResponse(statusCode: Int)
    /// Filing was attempted before a YouTrack connection was configured.
    case notConnected
    /// A Finding cannot file without a summary.
    case summaryRequired
    /// The server answered 403 to a filing step: the token authenticates,
    /// but the user lacks the permission the step needs.
    case permissionDenied(action: String)

    public var errorDescription: String? {
        switch self {
        case .invalidInstanceURL(let entered):
            "“\(entered)” is not a valid instance URL. Expected something like https://youtrack.example.com."
        case .insecureInstanceURL(let entered):
            "“\(entered)” is not secure: the permanent token would travel unencrypted. Use https://."
        case .tokenRejected:
            "YouTrack rejected the token. Check that the permanent token was pasted completely and is still valid."
        case .notAYouTrackInstance(let url):
            "\(url) did not answer like a YouTrack instance. Check the instance URL."
        case .unexpectedResponse(let statusCode):
            "YouTrack answered with HTTP \(statusCode). Check the instance URL, or try again later."
        case .notConnected:
            "Connect to YouTrack (instance URL + permanent token) before filing."
        case .summaryRequired:
            "The Finding needs a summary before it can be filed."
        case .permissionDenied(let action):
            "YouTrack denied permission to \(action). Ask a YouTrack administrator about your access."
        }
    }
}

extension AppCore {
    /// The credential-store key holding the designer's permanent token.
    static let youTrackTokenKey = "youtrack-token"

    /// The saved instance URL, or nil until the first successful connect.
    /// Present only when both persisted halves survive: the URL on disk and
    /// the token in the credential store.
    public func youTrackInstanceURL() throws -> URL? {
        try savedYouTrackCredentials()?.instanceURL
    }

    /// Verifies the pasted URL + token by fetching the connected user and
    /// the projects the designer can file into, then persists both halves —
    /// the token to the credential store, the URL to the workspace. Nothing
    /// is persisted unless the whole verification succeeds.
    @discardableResult
    public func connectYouTrack(instanceURL: String, token: String) async throws -> YouTrackConnection {
        let baseURL = try Self.normalizedInstanceURL(from: instanceURL)
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let connection = try await verifyYouTrack(instanceURL: baseURL, token: token)
        // Persist the fragile half first: a Keychain failure leaves any
        // previous connection untouched. If the URL write then fails, put
        // the previous token back so the saved state stays the old
        // consistent pair rather than a new-token/old-URL mismatch.
        let previousToken = try environment.credentialStore.secret(for: Self.youTrackTokenKey)
        try environment.credentialStore.setSecret(token, for: Self.youTrackTokenKey)
        do {
            try saveYouTrackInstanceURL(baseURL)
        } catch {
            try? environment.credentialStore.setSecret(previousToken, for: Self.youTrackTokenKey)
            throw error
        }
        return connection
    }

    /// Re-verifies a previously saved connection — the relaunch path.
    /// Nil when no connection has been saved yet.
    public func reconnectYouTrack() async throws -> YouTrackConnection? {
        guard let saved = try savedYouTrackCredentials() else { return nil }
        return try await verifyYouTrack(instanceURL: saved.instanceURL, token: saved.token)
    }

    // MARK: - Verification

    /// YouTrack collection endpoints return one default-sized page (42)
    /// unless $top is explicit; projects are fetched page by page.
    private static let projectPageSize = 100
    /// A misbehaving server that never sends a short page must not loop
    /// the app forever.
    private static let projectCountLimit = 10_000

    private func verifyYouTrack(instanceURL: URL, token: String) async throws -> YouTrackConnection {
        let user: MePayload = try await requestYouTrack(
            instanceURL: instanceURL, token: token,
            path: "api/users/me", query: "fields=login,fullName"
        )
        var projects: [ProjectPayload] = []
        while true {
            let page: [ProjectPayload] = try await requestYouTrack(
                instanceURL: instanceURL, token: token,
                path: "api/admin/projects",
                query: "fields=id,name,shortName&$top=\(Self.projectPageSize)&$skip=\(projects.count)"
            )
            projects.append(contentsOf: page)
            if page.count < Self.projectPageSize || projects.count >= Self.projectCountLimit {
                break
            }
        }
        return YouTrackConnection(
            user: YouTrackUser(login: user.login, fullName: user.fullName ?? user.login),
            projects: projects
                .map { YouTrackProject(id: $0.id, shortName: $0.shortName, name: $0.name) }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        )
    }

    /// One authorized round trip to the instance: builds the request, maps
    /// the status code to a designer-actionable error, decodes the payload.
    /// `deniedAction` turns a 403 into `permissionDenied` naming the step —
    /// during filing a 403 means a missing permission, not a bad token.
    func requestYouTrack<Payload: Decodable>(
        instanceURL: URL, token: String,
        method: String = "GET",
        path: String, query: String,
        body: (contentType: String, data: Data)? = nil,
        deniedAction: String? = nil
    ) async throws -> Payload {
        // The base URL is normalized; paths are compile-time constants plus
        // server-issued entity IDs. Composing by string keeps `,` and `$`
        // literal; the guard covers a server ID that no URL tolerates.
        guard let url = URL(string: "\(instanceURL.absoluteString)/\(path)?\(query)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue(body.contentType, forHTTPHeaderField: "Content-Type")
            request.httpBody = body.data
        }

        let (data, response) = try await environment.httpTransport.send(request)
        switch response.statusCode {
        case 200..<300: break
        case 401: throw YouTrackError.tokenRejected
        case 403:
            if let deniedAction { throw YouTrackError.permissionDenied(action: deniedAction) }
            throw YouTrackError.tokenRejected
        default: throw YouTrackError.unexpectedResponse(statusCode: response.statusCode)
        }
        do {
            return try JSONDecoder().decode(Payload.self, from: data)
        } catch {
            throw YouTrackError.notAYouTrackInstance(url: instanceURL.absoluteString)
        }
    }

    /// Normalizes what a designer pastes into a base URL: whitespace trimmed,
    /// https assumed when no scheme is given, trailing slashes dropped
    /// (a subpath like /youtrack is kept — self-hosted instances have them).
    static func normalizedInstanceURL(from entered: String) throws -> URL {
        let trimmed = entered.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw YouTrackError.invalidInstanceURL(entered: entered)
        }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard
            var components = URLComponents(string: withScheme),
            components.scheme == "https" || components.scheme == "http",
            let host = components.host, !host.isEmpty
        else {
            throw YouTrackError.invalidInstanceURL(entered: entered)
        }
        // The permanent token rides in every request header; cleartext http
        // is only tolerable when it never leaves the machine.
        let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]
        if components.scheme == "http", !loopbackHosts.contains(host.lowercased()) {
            throw YouTrackError.insecureInstanceURL(entered: entered)
        }
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") {
            components.path.removeLast()
        }
        guard let url = components.url else {
            throw YouTrackError.invalidInstanceURL(entered: entered)
        }
        return url
    }

    // MARK: - Persistence (URL on disk; the token never touches disk)

    private struct SavedYouTrackConfiguration: Codable {
        var instanceURL: URL
    }

    private var youTrackConfigurationFile: URL {
        workspaceDirectory.appendingPathComponent("youtrack.json")
    }

    private func saveYouTrackInstanceURL(_ url: URL) throws {
        try FileManager.default.createDirectory(at: workspaceDirectory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(SavedYouTrackConfiguration(instanceURL: url))
        try data.write(to: youTrackConfigurationFile, options: .atomic)
    }

    func savedYouTrackCredentials() throws -> (instanceURL: URL, token: String)? {
        guard
            let token = try environment.credentialStore.secret(for: Self.youTrackTokenKey),
            let data = try? Data(contentsOf: youTrackConfigurationFile)
        else { return nil }
        let saved = try JSONDecoder().decode(SavedYouTrackConfiguration.self, from: data)
        return (saved.instanceURL, token)
    }
}

/// The subset of `GET api/users/me` the core reads. `fullName` is nullable
/// server-side; display falls back to the login.
private struct MePayload: Decodable {
    var login: String
    var fullName: String?
}

/// The subset of `GET api/admin/projects` the core reads.
private struct ProjectPayload: Decodable {
    var id: String
    var name: String
    var shortName: String
}
