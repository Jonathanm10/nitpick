import Foundation
import NitpickCore
import Testing

/// The YouTrack connection leg through the app core's public API: connect
/// with instance URL + token, verify by fetching the connected user and the
/// projects the designer can file into, persist only on success, resume
/// after relaunch. Asserts the exact HTTP request shapes the core emits.
@Suite("YouTrack connection scenario")
struct YouTrackConnectionTests {
    static let userJSON = #"{"login":"vera","fullName":"Vera Baumann","$type":"Me"}"#
    static let projectsJSON = """
        [
            {"id":"0-12","name":"Review Me","shortName":"RM","$type":"Project"},
            {"id":"0-3","name":"Atlas","shortName":"ATL","$type":"Project"}
        ]
        """
    static let expectedConnection = YouTrackConnection(
        user: YouTrackUser(login: "vera", fullName: "Vera Baumann"),
        projects: [
            YouTrackProject(id: "0-3", shortName: "ATL", name: "Atlas"),
            YouTrackProject(id: "0-12", shortName: "RM", name: "Review Me"),
        ]
    )

    @Test("connect verifies user + projects with exact request shapes, persists, and survives relaunch")
    func connectAndRelaunch() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: credentials),
            workspaceDirectory: workspace
        )

        // Nothing saved yet: resuming is a no-op, no network touched.
        #expect(try await core.reconnectYouTrack() == nil)
        #expect(try core.youTrackInstanceURL() == nil)
        #expect(transport.sentRequests.isEmpty)

        // First-run settings: pasted URL and token arrive untidy.
        transport.enqueue(json: Self.userJSON)
        transport.enqueue(json: Self.projectsJSON)
        let connection = try await core.connectYouTrack(
            instanceURL: "youtrack.example.com/yt/",
            token: " perm:designer-token\n"
        )
        #expect(connection == Self.expectedConnection)

        // The exact request shapes: identity first, then filable projects.
        let expectedHeaders = [
            "Authorization": "Bearer perm:designer-token",
            "Accept": "application/json",
        ]
        try #require(transport.sentRequests.count == 2)
        for request in transport.sentRequests {
            #expect(request.httpMethod == "GET")
            #expect(request.allHTTPHeaderFields == expectedHeaders)
            #expect(request.httpBody == nil)
        }
        #expect(
            transport.sentRequests[0].url?.absoluteString
                == "https://youtrack.example.com/yt/api/users/me?fields=login,fullName"
        )
        #expect(
            transport.sentRequests[1].url?.absoluteString
                == "https://youtrack.example.com/yt/api/admin/projects?fields=id,name,shortName&$top=100&$skip=0"
        )

        // Both halves persisted: token in the credential store, URL on disk.
        #expect(credentials.storedSecrets.values.contains("perm:designer-token"))
        #expect(try core.youTrackInstanceURL() == URL(string: "https://youtrack.example.com/yt"))

        // Relaunch: a fresh core over the same workspace and credential
        // store re-verifies with the saved credentials.
        let relaunchTransport = FakeHTTPTransport()
        let relaunched = AppCore(
            environment: .fake(httpTransport: relaunchTransport, credentialStore: credentials),
            workspaceDirectory: workspace
        )
        relaunchTransport.enqueue(json: Self.userJSON)
        relaunchTransport.enqueue(json: Self.projectsJSON)
        let resumed = try await relaunched.reconnectYouTrack()
        #expect(resumed == Self.expectedConnection)
        try #require(relaunchTransport.sentRequests.count == 2)
        #expect(relaunchTransport.sentRequests[0].allHTTPHeaderFields == expectedHeaders)
        #expect(
            relaunchTransport.sentRequests[0].url?.absoluteString
                == "https://youtrack.example.com/yt/api/users/me?fields=login,fullName"
        )
    }

    @Test("more projects than one page: every page is fetched and merged")
    func projectPagination() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )

        // A full first page (100) means "maybe more"; the short second page
        // (1) ends the walk.
        let fullPage = (0..<100)
            .map { #"{"id":"0-\#($0)","name":"Project \#(String(format: "%03d", $0))","shortName":"P\#($0)"}"# }
            .joined(separator: ",")
        transport.enqueue(json: Self.userJSON)
        transport.enqueue(json: "[\(fullPage)]")
        transport.enqueue(json: #"[{"id":"0-100","name":"Project 100","shortName":"P100"}]"#)

        let connection = try await core.connectYouTrack(
            instanceURL: "https://youtrack.example.com", token: "perm:t"
        )
        #expect(connection.projects.count == 101)

        try #require(transport.sentRequests.count == 3)
        #expect(
            transport.sentRequests[1].url?.absoluteString
                == "https://youtrack.example.com/api/admin/projects?fields=id,name,shortName&$top=100&$skip=0"
        )
        #expect(
            transport.sentRequests[2].url?.absoluteString
                == "https://youtrack.example.com/api/admin/projects?fields=id,name,shortName&$top=100&$skip=100"
        )
    }

    @Test("a rejected token is an actionable error and persists nothing")
    func rejectedToken() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: credentials),
            workspaceDirectory: workspace
        )

        transport.enqueue(statusCode: 401, json: #"{"error":"Unauthorized"}"#)
        await #expect(throws: YouTrackError.tokenRejected) {
            try await core.connectYouTrack(instanceURL: "https://youtrack.example.com", token: "perm:expired")
        }
        #expect(credentials.storedSecrets.isEmpty)
        #expect(try core.youTrackInstanceURL() == nil)
        #expect(try await core.reconnectYouTrack() == nil)
    }

    @Test("a project fetch failure fails the whole connect and persists nothing")
    func projectFetchFailure() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: credentials),
            workspaceDirectory: workspace
        )

        transport.enqueue(json: Self.userJSON)
        transport.enqueue(statusCode: 500, json: #"{"error":"boom"}"#)
        await #expect(throws: YouTrackError.unexpectedResponse(statusCode: 500)) {
            try await core.connectYouTrack(instanceURL: "https://youtrack.example.com", token: "perm:t")
        }
        #expect(credentials.storedSecrets.isEmpty)
        #expect(try core.youTrackInstanceURL() == nil)
    }

    @Test("a reconfigure whose persistence fails keeps the previous connection intact")
    func reconfigurePersistenceFailure() async throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let credentials = FakeCredentialStore()
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: credentials),
            workspaceDirectory: workspace
        )

        transport.enqueue(json: Self.userJSON)
        transport.enqueue(json: Self.projectsJSON)
        try await core.connectYouTrack(instanceURL: "https://old.example", token: "perm:old")

        // Reconfigure towards a new instance, but the workspace has become
        // unwritable: verification succeeds, persisting the URL cannot.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: workspace.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: workspace.path)
        }
        transport.enqueue(json: Self.userJSON)
        transport.enqueue(json: Self.projectsJSON)
        await #expect(throws: (any Error).self) {
            try await core.connectYouTrack(instanceURL: "https://new.example", token: "perm:new")
        }

        // The old pair survives, still consistent: old URL, old token.
        #expect(try core.youTrackInstanceURL() == URL(string: "https://old.example"))
        #expect(credentials.storedSecrets == ["youtrack-token": "perm:old"])
    }

    @Test(
        "a malformed instance URL fails before any request",
        arguments: ["", "   ", "not a url", "ftp://youtrack.example.com", "https://"]
    )
    func malformedInstanceURL(entered: String) async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )

        await #expect(throws: YouTrackError.invalidInstanceURL(entered: entered)) {
            try await core.connectYouTrack(instanceURL: entered, token: "perm:t")
        }
        #expect(transport.sentRequests.isEmpty)
    }

    @Test(
        "a cleartext http URL beyond loopback is rejected before the token leaves the app",
        arguments: ["http://youtrack.example.com", "http://10.0.0.5/yt", "http://LOCALHOST.example.com"]
    )
    func insecureInstanceURL(entered: String) async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )

        await #expect(throws: YouTrackError.insecureInstanceURL(entered: entered)) {
            try await core.connectYouTrack(instanceURL: entered, token: "perm:t")
        }
        #expect(transport.sentRequests.isEmpty)
    }

    @Test("cleartext http to loopback is allowed — it never leaves the machine")
    func loopbackHTTPAllowed() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )

        transport.enqueue(json: Self.userJSON)
        transport.enqueue(json: Self.projectsJSON)
        try await core.connectYouTrack(instanceURL: "http://localhost:8080", token: "perm:t")
        #expect(
            transport.sentRequests.first?.url?.absoluteString
                == "http://localhost:8080/api/users/me?fields=login,fullName"
        )
    }

    @Test("a URL that answers with something other than YouTrack JSON is called out")
    func notAYouTrackInstance() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )

        transport.enqueue(json: "<!DOCTYPE html><html>intranet portal</html>")
        await #expect(throws: YouTrackError.notAYouTrackInstance(url: "https://intranet.example.com")) {
            try await core.connectYouTrack(instanceURL: "intranet.example.com", token: "perm:t")
        }
    }

    @Test("a network failure propagates instead of being swallowed")
    func networkFailurePropagates() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )

        transport.enqueue(error: URLError(.notConnectedToInternet))
        await #expect(throws: URLError(.notConnectedToInternet)) {
            try await core.connectYouTrack(instanceURL: "youtrack.example.com", token: "perm:t")
        }
    }

    @Test("connection errors speak to the designer")
    func errorMessagesAreActionable() {
        #expect(
            YouTrackError.invalidInstanceURL(entered: "nope").errorDescription?
                .contains("https://youtrack.example.com") == true
        )
        #expect(YouTrackError.tokenRejected.errorDescription?.contains("token") == true)
        #expect(
            YouTrackError.notAYouTrackInstance(url: "https://x.example").errorDescription?
                .contains("https://x.example") == true
        )
        #expect(
            YouTrackError.unexpectedResponse(statusCode: 502).errorDescription?.contains("502") == true
        )
    }
}
