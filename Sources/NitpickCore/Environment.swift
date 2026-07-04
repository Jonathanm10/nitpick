import Foundation

/// The single effects seam injected into the app core. It holds the only
/// out-of-process effects: subprocess execution, HTTP transport, and the
/// credential store. Everything else (filesystem, plist parsing) is
/// in-process and unseamed by design.
public struct CoreEnvironment: Sendable {
    public var subprocess: any SubprocessRunner
    public var httpTransport: any HTTPTransport
    public var credentialStore: any CredentialStore

    public init(
        subprocess: any SubprocessRunner,
        httpTransport: any HTTPTransport,
        credentialStore: any CredentialStore
    ) {
        self.subprocess = subprocess
        self.httpTransport = httpTransport
        self.credentialStore = credentialStore
    }

    /// The production environment. HTTP transport and credential store are
    /// stubbed until the YouTrack connection slice (issue 02).
    public static func live() -> CoreEnvironment {
        CoreEnvironment(
            subprocess: ProcessSubprocessRunner(),
            httpTransport: UnimplementedHTTPTransport(),
            credentialStore: UnimplementedCredentialStore()
        )
    }
}

/// The HTTP effects seam. Unused until the YouTrack connection slice.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse)
}

/// The credential effects seam. Unused until the YouTrack connection slice.
public protocol CredentialStore: Sendable {
    func secret(for key: String) throws -> String?
    func setSecret(_ secret: String?, for key: String) throws
}

/// Reaching an effect no slice has implemented yet is a programmer error
/// surfaced as a thrown error, never a crash.
public struct UnimplementedEffect: Error, LocalizedError {
    public var name: String

    public init(name: String) {
        self.name = name
    }

    public var errorDescription: String? {
        "\(name) is not implemented yet."
    }
}

public struct UnimplementedHTTPTransport: HTTPTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        throw UnimplementedEffect(name: "HTTP transport")
    }
}

public struct UnimplementedCredentialStore: CredentialStore {
    public init() {}

    public func secret(for key: String) throws -> String? {
        throw UnimplementedEffect(name: "Credential store")
    }

    public func setSecret(_ secret: String?, for key: String) throws {
        throw UnimplementedEffect(name: "Credential store")
    }
}
