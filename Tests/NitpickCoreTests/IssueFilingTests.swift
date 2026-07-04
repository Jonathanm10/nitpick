import Foundation
import NitpickCore
import Testing

/// Filing one Finding through the app core's public API: exactly one issue,
/// authored by the token's user, carrying summary, description + metadata
/// block, the screenshot, and the design-review tag. Asserts the exact HTTP
/// requests the core emits — endpoint, JSON body bytes, multipart bytes.
@Suite("Issue filing")
struct IssueFilingTests {
    static let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF])

    static let session = ReviewSession(
        build: Build(
            identity: BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"),
            appBundleURL: URL(fileURLWithPath: "/tmp/ReviewMe.app", isDirectory: true)
        ),
        project: YouTrackProject(id: "0-12", shortName: "RM", name: "Review Me"),
        startedAt: Date(timeIntervalSince1970: 1_783_156_532)  // 2026-07-04T09:15:32Z
    )

    static func finding(
        summary: String = "Button color is off",
        description: String = "The primary button is #FF0000, the design says #E64545."
    ) -> Finding {
        Finding(
            summary: summary,
            description: description,
            screenshotPNG: pngBytes,
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )
    }

    /// The exact JSON body issue creation must carry: designer description,
    /// blank line, metadata block; keys sorted.
    static let expectedIssueJSON = #"{"description":"The primary button is #FF0000, the design says #E64545.\n\n"#
        + #"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n"#
        + #"Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}"#

    static let existingTagJSON = #"[{"id":"6-4","name":"design-review","$type":"Tag"}]"#
    static let createdIssueJSON = #"{"id":"3-505","idReadable":"RM-421","$type":"Issue"}"#
    static let attachmentsJSON = #"[{"id":"134-31","name":"capture.png","$type":"IssueAttachment"}]"#
    static let appliedTagJSON = #"{"id":"6-4","name":"design-review","$type":"Tag"}"#

    /// A core with a saved connection, as the designer has after settings:
    /// the connect consumes the first two stubs and two requests.
    static func connectedCore(transport: FakeHTTPTransport) async throws -> AppCore {
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )
        transport.enqueue(json: YouTrackConnectionTests.userJSON)
        transport.enqueue(json: YouTrackConnectionTests.projectsJSON)
        try await core.connectYouTrack(instanceURL: "https://youtrack.example.com/yt", token: "perm:designer-token")
        return core
    }

    @Test("filing emits find-tag → create issue → attach screenshot → apply tag, with exact bodies")
    func filesOneIssue() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: Self.appliedTagJSON)

        let filed = try await core.file(Self.finding(), in: Self.session)
        #expect(filed == FiledIssue(
            idReadable: "RM-421",
            url: URL(string: "https://youtrack.example.com/yt/issue/RM-421")!
        ))

        let requests = transport.sentRequests.dropFirst(2)
        try #require(requests.count == 4)
        let base = "https://youtrack.example.com/yt"
        for request in requests {
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer perm:designer-token")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        }

        // 1. The tag is looked up by name.
        let tagLookup = requests[requests.startIndex]
        #expect(tagLookup.httpMethod == "GET")
        #expect(tagLookup.url?.absoluteString == "\(base)/api/tags?fields=id,name&query=design-review&$top=100")
        #expect(tagLookup.httpBody == nil)

        // 2. Exactly one issue is created: summary + description with the
        //    metadata block appended, in the session's project.
        let creation = requests[requests.startIndex + 1]
        #expect(creation.httpMethod == "POST")
        #expect(creation.url?.absoluteString == "\(base)/api/issues?fields=id,idReadable")
        #expect(creation.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == Self.expectedIssueJSON)

        // 3. The screenshot rides as one multipart `upload` part.
        let attach = requests[requests.startIndex + 2]
        #expect(attach.httpMethod == "POST")
        #expect(attach.url?.absoluteString == "\(base)/api/issues/3-505/attachments?fields=id,name")
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        var expectedBody = Data((
            "--\(boundary)\r\n"
                + "Content-Disposition: form-data; name=\"upload\"; filename=\"capture.png\"\r\n"
                + "Content-Type: image/png\r\n"
                + "\r\n"
        ).utf8)
        expectedBody.append(Self.pngBytes)
        expectedBody.append(Data("\r\n--\(boundary)--\r\n".utf8))
        #expect(attach.httpBody == expectedBody)

        // 4. The fixed design-review tag is applied by ID.
        let tagging = requests[requests.startIndex + 3]
        #expect(tagging.httpMethod == "POST")
        #expect(tagging.url?.absoluteString == "\(base)/api/issues/3-505/tags?fields=id,name")
        #expect(tagging.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(tagging.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"id":"6-4"}"#)
    }

    @Test("a missing design-review tag is created on first use, before the issue")
    func createsMissingTag() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        // The lookup finds only a lookalike; exact-name matching rejects it.
        transport.enqueue(json: #"[{"id":"6-9","name":"design-review-2024","$type":"Tag"}]"#)
        transport.enqueue(json: #"{"id":"6-77","name":"design-review","$type":"Tag"}"#)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: #"{"id":"6-77","name":"design-review","$type":"Tag"}"#)

        _ = try await core.file(Self.finding(), in: Self.session)

        let requests = transport.sentRequests.dropFirst(2)
        try #require(requests.count == 5)
        let creation = requests[requests.startIndex + 1]
        #expect(creation.httpMethod == "POST")
        #expect(creation.url?.absoluteString == "https://youtrack.example.com/yt/api/tags?fields=id,name")
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"name":"design-review"}"#)
        // The freshly created tag's ID is the one applied.
        let tagging = requests[requests.startIndex + 4]
        #expect(tagging.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"id":"6-77"}"#)
    }

    @Test("an empty description files the metadata block alone — no leading blank lines")
    func emptyDescription() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: Self.appliedTagJSON)

        _ = try await core.file(Self.finding(description: "  \n"), in: Self.session)

        let creation = transport.sentRequests[3]
        let expected = #"{"description":"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n"#
            + #"Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}"#
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == expected)
    }

    @Test("filing before connecting is an actionable error; nothing reaches the network")
    func notConnected() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )
        await #expect(throws: YouTrackError.notConnected) {
            try await core.file(Self.finding(), in: Self.session)
        }
        #expect(transport.sentRequests.isEmpty)
    }

    @Test("a blank summary never reaches the network")
    func blankSummary() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        await #expect(throws: YouTrackError.summaryRequired) {
            try await core.file(Self.finding(summary: "  \n"), in: Self.session)
        }
        #expect(transport.sentRequests.count == 2)
    }

    @Test("a 403 on issue creation names the missing permission, not the token")
    func permissionDenied() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        await #expect(throws: YouTrackError.permissionDenied(action: "create an issue in Review Me")) {
            try await core.file(Self.finding(), in: Self.session)
        }
        // Nothing after the refused creation: no attach, no tagging.
        #expect(transport.sentRequests.count == 4)
    }

    @Test("a creation failure propagates — the required-custom-fields signal, not a crash")
    func creationFailure() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(statusCode: 400, json: #"{"error":"Bad Request"}"#)

        await #expect(throws: YouTrackError.unexpectedResponse(statusCode: 400)) {
            try await core.file(Self.finding(), in: Self.session)
        }
        #expect(transport.sentRequests.count == 4)
    }

    @Test("filing errors speak to the designer")
    func errorMessagesAreActionable() {
        #expect(
            YouTrackError.notConnected.errorDescription
                == "Connect to YouTrack (instance URL + permanent token) before filing."
        )
        #expect(
            YouTrackError.summaryRequired.errorDescription
                == "The Finding needs a summary before it can be filed."
        )
        #expect(
            YouTrackError.permissionDenied(action: "create an issue in Review Me").errorDescription
                == "YouTrack denied permission to create an issue in Review Me. Ask a YouTrack administrator about your access."
        )
    }
}
