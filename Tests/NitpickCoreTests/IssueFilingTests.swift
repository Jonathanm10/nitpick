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
    static let attachmentsJSON = #"[{"id":"134-31","name":"annotated.png","$type":"IssueAttachment"},"#
        + #"{"id":"134-32","name":"original.png","$type":"IssueAttachment"}]"#
    static let appliedTagJSON = #"{"id":"6-4","name":"design-review","$type":"Tag"}"#
    /// The `nitpick-type:bug` tag (glossary: Type), looked up and applied
    /// alongside `design-review` — every default finding here is a Bug.
    static let existingTypeTagJSON = #"[{"id":"6-5","name":"nitpick-type:bug","$type":"Tag"}]"#
    static let appliedTypeTagJSON = #"{"id":"6-5","name":"nitpick-type:bug","$type":"Tag"}"#

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

    /// The exact multipart body the attachments endpoint must receive: one
    /// `upload` part per file, CRLF line breaks, one closing boundary.
    static func multipartBody(boundary: Substring, files: [(fileName: String, data: Data)]) -> Data {
        var body = Data()
        for file in files {
            body.append(Data((
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data; name=\"upload\"; filename=\"\(file.fileName)\"\r\n"
                    + "Content-Type: image/png\r\n"
                    + "\r\n"
            ).utf8))
            body.append(file.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        return body
    }

    @Test("filing emits find-tag ×2 → create issue → attach both screenshots → apply both tags, with exact bodies")
    func filesOneIssue() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(json: Self.existingTypeTagJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: Self.appliedTagJSON)
        transport.enqueue(json: Self.appliedTypeTagJSON)

        let filed = try await core.file(Self.finding(), in: Self.session)
        #expect(filed == FiledIssue(
            idReadable: "RM-421",
            url: URL(string: "https://youtrack.example.com/yt/issue/RM-421")!
        ))

        let requests = transport.sentRequests.dropFirst(2)
        try #require(requests.count == 6)
        let base = "https://youtrack.example.com/yt"
        for request in requests {
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer perm:designer-token")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        }

        // 1. Both tags are looked up by name, before any issue exists:
        //    the fixed design-review tag, then the Finding's Type tag.
        let tagLookup = requests[requests.startIndex]
        #expect(tagLookup.httpMethod == "GET")
        #expect(tagLookup.url?.absoluteString == "\(base)/api/tags?fields=id,name&query=design-review&$top=100")
        #expect(tagLookup.httpBody == nil)
        let typeTagLookup = requests[requests.startIndex + 1]
        #expect(typeTagLookup.httpMethod == "GET")
        #expect(typeTagLookup.url?.absoluteString == "\(base)/api/tags?fields=id,name&query=nitpick-type:bug&$top=100")
        #expect(typeTagLookup.httpBody == nil)

        // 2. Exactly one issue is created: summary + description with the
        //    metadata block appended, in the session's project.
        let creation = requests[requests.startIndex + 2]
        #expect(creation.httpMethod == "POST")
        #expect(creation.url?.absoluteString == "\(base)/api/issues?fields=id,idReadable")
        #expect(creation.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == Self.expectedIssueJSON)

        // 3. Both screenshots ride in one multipart request: the annotated
        //    variant first, the clean original second. Unannotated, the
        //    annotated variant is the original bytes.
        let attach = requests[requests.startIndex + 3]
        #expect(attach.httpMethod == "POST")
        #expect(attach.url?.absoluteString == "\(base)/api/issues/3-505/attachments?fields=id,name")
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == Self.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: Self.pngBytes),
            (fileName: "original.png", data: Self.pngBytes),
        ]))

        // 4. The design-review tag is applied first, then the Type tag —
        //    each by ID, one tag per request.
        let tagging = requests[requests.startIndex + 4]
        #expect(tagging.httpMethod == "POST")
        #expect(tagging.url?.absoluteString == "\(base)/api/issues/3-505/tags?fields=id,name")
        #expect(tagging.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(tagging.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"id":"6-4"}"#)
        let typeTagging = requests[requests.startIndex + 5]
        #expect(typeTagging.httpMethod == "POST")
        #expect(typeTagging.url?.absoluteString == "\(base)/api/issues/3-505/tags?fields=id,name")
        #expect(typeTagging.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"id":"6-5"}"#)
    }

    @Test("an annotated Finding attaches the flattened variant plus the untouched original")
    func attachesAnnotatedAndOriginal() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(json: Self.existingTypeTagJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: Self.appliedTagJSON)
        transport.enqueue(json: Self.appliedTypeTagJSON)

        let original = try ImageFixtures.solidPNG(width: 480, height: 960)
        var finding = Finding(
            summary: "Button color is off",
            description: "",
            screenshotPNG: original,
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )
        finding.add(Annotation(.rectangle(CGRect(x: 60, y: 500, width: 240, height: 160))))

        _ = try await core.file(finding, in: Self.session)

        let attach = transport.sentRequests[5]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == Self.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: try finding.annotatedScreenshotPNG()),
            (fileName: "original.png", data: original),
        ]))
        #expect(try finding.annotatedScreenshotPNG() != original)
    }

    @Test("a flattening failure aborts before any issue exists — no orphans")
    func flatteningFailureLeavesNoOrphan() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)

        var finding = Self.finding()  // 9 fake bytes: not a decodable image
        finding.add(Annotation(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10))))

        await #expect(throws: AnnotationRenderingError.unreadableScreenshot) {
            try await core.file(finding, in: Self.session)
        }
        // Nothing beyond the two connect requests reached the network.
        #expect(transport.sentRequests.count == 2)
    }

    @Test("a missing design-review tag is created on first use, before the issue")
    func createsMissingTag() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        // The lookup finds only a lookalike; exact-name matching rejects it
        // and the tag is created before the issue. The Type tag already
        // exists, so its lookup is a single GET.
        transport.enqueue(json: #"[{"id":"6-9","name":"design-review-2024","$type":"Tag"}]"#)
        transport.enqueue(json: #"{"id":"6-77","name":"design-review","$type":"Tag"}"#)
        transport.enqueue(json: Self.existingTypeTagJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: #"{"id":"6-77","name":"design-review","$type":"Tag"}"#)
        transport.enqueue(json: Self.appliedTypeTagJSON)

        _ = try await core.file(Self.finding(), in: Self.session)

        let requests = transport.sentRequests.dropFirst(2)
        try #require(requests.count == 7)
        let creation = requests[requests.startIndex + 1]
        #expect(creation.httpMethod == "POST")
        #expect(creation.url?.absoluteString == "https://youtrack.example.com/yt/api/tags?fields=id,name")
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"name":"design-review"}"#)
        // The freshly created tag's ID is the one applied.
        let tagging = requests[requests.startIndex + 5]
        #expect(tagging.httpBody.map { String(decoding: $0, as: UTF8.self) } == #"{"id":"6-77"}"#)
    }

    @Test("an empty description files the metadata block alone — no leading blank lines")
    func emptyDescription() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(json: Self.existingTypeTagJSON)
        transport.enqueue(json: Self.createdIssueJSON)
        transport.enqueue(json: Self.attachmentsJSON)
        transport.enqueue(json: Self.appliedTagJSON)
        transport.enqueue(json: Self.appliedTypeTagJSON)

        _ = try await core.file(Self.finding(description: "  \n"), in: Self.session)

        let creation = transport.sentRequests[4]
        let expected = #"{"description":"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n"#
            + #"Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}"#
        #expect(creation.httpBody.map { String(decoding: $0, as: UTF8.self) } == expected)
    }

    @Test("a session-level Design Reference lands in every filed issue; a Finding's own overrides it")
    func sessionDesignReferencePrecedence() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        var session = Self.session
        session.designReference = URL(string: "https://www.figma.com/file/sess42/ReviewMe")!

        // One ladder per filing: find both tags → create → attach → tag ×2.
        for _ in 0..<2 {
            transport.enqueue(json: Self.existingTagJSON)
            transport.enqueue(json: Self.existingTypeTagJSON)
            transport.enqueue(json: Self.createdIssueJSON)
            transport.enqueue(json: Self.attachmentsJSON)
            transport.enqueue(json: Self.appliedTagJSON)
            transport.enqueue(json: Self.appliedTypeTagJSON)
        }

        _ = try await core.file(Self.finding(), in: session)
        var overriding = Self.finding()
        overriding.designReference = URL(string: "https://www.figma.com/file/abc123/ReviewMe")!
        _ = try await core.file(overriding, in: session)

        let bodies = transport.sentRequests.dropFirst(2)
            .filter { $0.url?.path().hasSuffix("api/issues") == true }
            .compactMap { $0.httpBody.map { String(decoding: $0, as: UTF8.self) } }
        try #require(bodies.count == 2)
        let designLine = { (url: String) in
            #"{"description":"The primary button is #FF0000, the design says #E64545.\n\n"#
                + #"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n"#
                + #"Design: \#(url)\n"#
                + #"Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"summary":"Button color is off"}"#
        }
        #expect(bodies[0] == designLine("https://www.figma.com/file/sess42/ReviewMe"))
        #expect(bodies[1] == designLine("https://www.figma.com/file/abc123/ReviewMe"))
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
        transport.enqueue(json: Self.existingTypeTagJSON)
        transport.enqueue(statusCode: 403, json: #"{"error":"Forbidden"}"#)

        await #expect(throws: YouTrackError.permissionDenied(action: "create an issue in Review Me")) {
            try await core.file(Self.finding(), in: Self.session)
        }
        // Nothing after the refused creation: no attach, no tagging.
        #expect(transport.sentRequests.count == 5)
    }

    @Test("a creation failure propagates — the required-custom-fields signal, not a crash")
    func creationFailure() async throws {
        let transport = FakeHTTPTransport()
        let core = try await Self.connectedCore(transport: transport)
        transport.enqueue(json: Self.existingTagJSON)
        transport.enqueue(json: Self.existingTypeTagJSON)
        transport.enqueue(statusCode: 400, json: #"{"error":"Bad Request"}"#)

        await #expect(throws: YouTrackError.unexpectedResponse(statusCode: 400)) {
            try await core.file(Self.finding(), in: Self.session)
        }
        #expect(transport.sentRequests.count == 5)
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
