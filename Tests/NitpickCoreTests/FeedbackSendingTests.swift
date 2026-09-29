import Foundation
import NitpickCore
import Testing

/// Sending a Feedback about nitpick through the app core's public API:
/// exactly one Issue in the `NIT` project, tagged `nitpick-feedback:<kind>`,
/// with the Environment section appended and no custom fields. Asserts the
/// exact HTTP requests the core emits, in the style of `IssueFilingTests`.
@Suite("Feedback sending")
struct FeedbackSendingTests {
    static let base = "https://youtrack.example.com/yt"
    static let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xAB])

    static let versionLines = [
        Feedback.EnvironmentLine(label: "nitpick", value: "1.4.0 (57)"),
        Feedback.EnvironmentLine(label: "macOS", value: "Version 26.1 (Build 25B78)"),
        Feedback.EnvironmentLine(label: "Xcode", value: "26.1"),
    ]
    /// What the shell adds while a Review Session is open.
    static let buildLines = [
        Feedback.EnvironmentLine(label: "Build", value: "ch.liip.reviewme 2.1.0 (421)"),
        Feedback.EnvironmentLine(label: "Capture Source", value: "iPhone 17 Pro"),
    ]

    static func feedback(
        kind: FeedbackKind = .bug,
        title: String = "  Tray loses focus after capture \n",
        description: String = "After capturing, the summary field is not focused.",
        environment: [Feedback.EnvironmentLine] = versionLines,
        imagePNG: Data? = nil
    ) -> Feedback {
        Feedback(kind: kind, title: title, description: description, environment: environment, imagePNG: imagePNG)
    }

    static let existingBugTagJSON = #"[{"id":"6-3910","name":"nitpick-feedback:bug","$type":"Tag"}]"#
    static let projectJSON = #"{"id":"0-77","name":"Nitpick","$type":"Project"}"#
    static let createdIssueJSON = #"{"id":"3-900","idReadable":"NIT-42","$type":"Issue"}"#
    static let appliedBugTagJSON = #"{"id":"6-3910","name":"nitpick-feedback:bug","$type":"Tag"}"#
    static let attachmentsJSON = #"[{"id":"134-90","name":"nitpick-window.png","$type":"IssueAttachment"}]"#

    static let expectedIssueJSON = #"{"description":"After capturing, the summary field is not focused.\n\n"#
        + #"## Environment\n- nitpick: 1.4.0 (57)\n- macOS: Version 26.1 (Build 25B78)\n- Xcode: 26.1","#
        + #""project":{"id":"0-77"},"summary":"Tray loses focus after capture"}"#

    static func body(_ request: URLRequest) -> String? {
        request.httpBody.map { String(decoding: $0, as: UTF8.self) }
    }

    /// The happy-path responses after the connect: tag found, project,
    /// issue, tag applied.
    static func enqueueLadder(on transport: FakeHTTPTransport) {
        transport.enqueue(json: existingBugTagJSON)
        transport.enqueue(json: projectJSON)
        transport.enqueue(json: createdIssueJSON)
        transport.enqueue(json: appliedBugTagJSON)
    }

    @Test("send emits find-tag → find NIT → create issue → apply tag, with exact bodies and no custom fields")
    func sendsOneIssue() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        Self.enqueueLadder(on: transport)

        let sent = try await core.send(Self.feedback())
        #expect(sent == SentFeedback(idReadable: "NIT-42", url: URL(string: "\(Self.base)/issue/NIT-42")!))

        let requests = Array(transport.sentRequests.dropFirst(2))
        try #require(requests.count == 4)
        for request in requests {
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer perm:designer-token")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        }

        // 1. The kind's tag is resolved before anything else exists.
        #expect(requests[0].httpMethod == "GET")
        #expect(requests[0].url?.absoluteString == "\(Self.base)/api/tags?fields=id,name&query=nitpick-feedback:bug&$top=100")

        // 2. The project is resolved by its fixed shortName, never persisted.
        #expect(requests[1].httpMethod == "GET")
        #expect(requests[1].url?.absoluteString == "\(Self.base)/api/admin/projects/NIT?fields=id,name")
        #expect(requests[1].httpBody == nil)

        // 3. One issue: trimmed summary, Markdown body ending in the
        //    Environment section, the resolved project, no customFields.
        #expect(requests[2].httpMethod == "POST")
        #expect(requests[2].url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable")
        #expect(requests[2].value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(Self.body(requests[2]) == Self.expectedIssueJSON)
        #expect(Self.body(requests[2])?.contains("customFields") == false)

        // 4. The tag resolved in step 1 is applied by ID.
        #expect(requests[3].httpMethod == "POST")
        #expect(requests[3].url?.absoluteString == "\(Self.base)/api/issues/3-900/tags?fields=id,name")
        #expect(Self.body(requests[3]) == #"{"id":"6-3910"}"#)
    }

    @Test("a missing nitpick-feedback tag is created by exact name before the project and issue")
    func createsMissingTag() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        // Only a lookalike exists; exact-name matching rejects it.
        transport.enqueue(json: #"[{"id":"6-1","name":"nitpick-feedback:improvements","$type":"Tag"}]"#)
        transport.enqueue(json: #"{"id":"6-3911","name":"nitpick-feedback:improvement","$type":"Tag"}"#)
        transport.enqueue(json: Self.projectJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: #"{"id":"6-3911","name":"nitpick-feedback:improvement","$type":"Tag"}"#)

        _ = try await core.send(Self.feedback(kind: .improvement))

        let requests = Array(transport.sentRequests.dropFirst(2))
        try #require(requests.count == 5)
        #expect(requests[0].url?.absoluteString == "\(Self.base)/api/tags?fields=id,name&query=nitpick-feedback:improvement&$top=100")
        #expect(requests[1].httpMethod == "POST")
        #expect(requests[1].url?.absoluteString == "\(Self.base)/api/tags?fields=id,name")
        #expect(Self.body(requests[1]) == #"{"name":"nitpick-feedback:improvement"}"#)
        #expect(requests[2].url?.absoluteString == "\(Self.base)/api/admin/projects/NIT?fields=id,name")
        #expect(requests[3].url?.absoluteString == "\(Self.base)/api/issues?fields=id,idReadable")
        #expect(Self.body(requests[4]) == #"{"id":"6-3911"}"#)
    }

    @Test("a 401 on tag lookup is tokenRejected and no issue is created")
    func tokenRejectedOnTag() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(statusCode: 401, json: #"{"error":"Unauthorized"}"#)

        await #expect(throws: YouTrackError.tokenRejected) {
            try await core.send(Self.feedback())
        }
        #expect(transport.sentRequests.count == 3)
    }

    @Test("a 403 on tag creation names the permission and no issue is created")
    func tagCreationDenied() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: "[]")
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        await #expect(throws: YouTrackError.permissionDenied(
            action: "create the “nitpick-feedback:bug” tag (it does not exist yet)"
        )) {
            try await core.send(Self.feedback())
        }
        #expect(transport.sentRequests.count == 4)
        #expect(!transport.sentRequests.contains { $0.url?.path().hasSuffix("api/issues") == true })
    }

    @Test("a 403 on the NIT project lookup names the permission and no issue is created")
    func projectLookupDenied() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingBugTagJSON)
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        await #expect(throws: YouTrackError.permissionDenied(action: "read the NIT project")) {
            try await core.send(Self.feedback())
        }
        #expect(transport.sentRequests.count == 4)
    }

    @Test("a 403 on issue creation names the NIT project; nothing is tagged")
    func creationDenied() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingBugTagJSON)
        transport.enqueue(json: Self.projectJSON)
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        await #expect(throws: YouTrackError.permissionDenied(action: "create an issue in Nitpick")) {
            try await core.send(Self.feedback())
        }
        #expect(transport.sentRequests.count == 5)
    }

    @Test("Build lines appear in the Environment section, in the given order, only when supplied")
    func environmentLinesInOrder() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        Self.enqueueLadder(on: transport)
        Self.enqueueLadder(on: transport)

        // No Review Session open: versions only.
        _ = try await core.send(Self.feedback(description: ""))
        // A Review Session open: the shell appends the Build lines.
        _ = try await core.send(Self.feedback(description: "", environment: Self.versionLines + Self.buildLines))

        let bodies = transport.sentRequests
            .filter { $0.url?.path().hasSuffix("api/issues") == true }
            .compactMap(Self.body)
        try #require(bodies.count == 2)
        // An empty description sends the Environment section alone.
        let versions = #"## Environment\n- nitpick: 1.4.0 (57)\n- macOS: Version 26.1 (Build 25B78)\n- Xcode: 26.1"#
        #expect(bodies[0] == #"{"description":"\#(versions)","project":{"id":"0-77"},"summary":"Tray loses focus after capture"}"#)
        #expect(bodies[1] == #"{"description":"\#(versions)\n- Build: ch.liip.reviewme 2.1.0 (421)\n- Capture Source: iPhone 17 Pro","#
            + #""project":{"id":"0-77"},"summary":"Tray loses focus after capture"}"#)
        #expect(!bodies[0].contains("Build:"))
    }

    @Test("an optional window image is uploaded as multipart after the tag")
    func uploadsImage() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        Self.enqueueLadder(on: transport)
        transport.enqueue(json: Self.attachmentsJSON)

        _ = try await core.send(Self.feedback(imagePNG: Self.pngBytes))

        let requests = Array(transport.sentRequests.dropFirst(2))
        try #require(requests.count == 5)
        #expect(requests[3].url?.absoluteString == "\(Self.base)/api/issues/3-900/tags?fields=id,name")
        let attach = requests[4]
        #expect(attach.httpMethod == "POST")
        #expect(attach.url?.absoluteString == "\(Self.base)/api/issues/3-900/attachments?fields=id,name")
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == IssueFilingTests.multipartBody(boundary: boundary, files: [
            (fileName: "nitpick-window.png", data: Self.pngBytes),
        ]))
    }

    @Test("no image, no attachments request")
    func noImageNoUpload() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        Self.enqueueLadder(on: transport)

        _ = try await core.send(Self.feedback())
        #expect(!transport.sentRequests.contains { $0.url?.path().hasSuffix("attachments") == true })
    }

    @Test("an environment value the shell could not read is sent verbatim as “unknown”")
    func unknownVersionPassesThrough() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        Self.enqueueLadder(on: transport)

        _ = try await core.send(Self.feedback(description: "", environment: [
            Feedback.EnvironmentLine(label: "nitpick", value: "unknown"),
            Feedback.EnvironmentLine(label: "Xcode", value: "unknown"),
        ]))

        let creation = transport.sentRequests[4]
        #expect(Self.body(creation) == ###"{"description":"## Environment\n- nitpick: unknown\n- Xcode: unknown","###
            + #""project":{"id":"0-77"},"summary":"Tray loses focus after capture"}"#)
    }

    @Test("sending before connecting is the not-connected error; nothing reaches the network")
    func notConnected() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )
        await #expect(throws: YouTrackError.notConnected) {
            try await core.send(Self.feedback())
        }
        #expect(transport.sentRequests.isEmpty)
    }

    @Test("a blank title never reaches the network")
    func blankTitle() async throws {
        let transport = FakeHTTPTransport()
        let core = try await IssueFilingTests.connectedCore(transport: transport)
        await #expect(throws: YouTrackError.feedbackTitleRequired) {
            try await core.send(Self.feedback(title: " \n"))
        }
        #expect(transport.sentRequests.count == 2)
    }

    @Test("Feedback kinds map to their nitpick-feedback tags")
    func kindTagNames() {
        #expect(FeedbackKind.bug.tagName == "nitpick-feedback:bug")
        #expect(FeedbackKind.improvement.tagName == "nitpick-feedback:improvement")
        #expect(AppCore.feedbackProjectShortName == "NIT")
    }
}
