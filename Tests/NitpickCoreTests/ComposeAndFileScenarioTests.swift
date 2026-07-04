import Foundation
import NitpickCore
import Testing

/// The first complete Review Session, end to end through the app core's
/// public API: connect → ingest → launch → capture → compose → file. The
/// project is chosen exactly once at session start; filing asserts the
/// exact HTTP requests — issue JSON, multipart screenshot, design-review
/// tag — and surfaces the issue ID + link.
@Suite("Compose and file scenario")
struct ComposeAndFileScenarioTests {
    @Test("a captured Finding files as exactly one issue with metadata block, screenshot, and tag")
    func wholeFlow() async throws {
        let temp = try Fixtures.makeTemporaryDirectory()
        let workspace = temp.appendingPathComponent("workspace", isDirectory: true)
        let runner = FakeSubprocessRunner()
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(
                subprocess: runner,
                httpTransport: transport,
                credentialStore: FakeCredentialStore()
            ),
            workspaceDirectory: workspace
        )

        // The designer connected to YouTrack in settings…
        transport.enqueue(json: YouTrackConnectionTests.userJSON)
        transport.enqueue(json: YouTrackConnectionTests.projectsJSON)
        let connection = try await core.connectYouTrack(
            instanceURL: "https://youtrack.example.com", token: "perm:designer-token"
        )

        // …drags in the CI-produced Build…
        let appBundle = try Fixtures.writeAppBundle(
            named: "ReviewMe.app", in: temp, infoPlist: Fixtures.simulatorInfoPlist()
        )
        let build = try await core.ingestBuild(at: appBundle)

        // …picks a device, boots, installs, launches…
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data(SimulatorDeviceTests.deviceListJSON.utf8)))
        let devices = try await core.simulatorDevices()
        let device = try #require(devices.first { $0.name == "iPhone 17 Pro" })
        for _ in 0..<5 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        try await core.launch(build, on: device)

        // …and starts the Review Session by choosing the project — once.
        let project = try #require(connection.projects.first { $0.shortName == "RM" })
        let session = ReviewSession(
            build: build, project: project,
            startedAt: Date(timeIntervalSince1970: 1_783_156_532)  // 2026-07-04T09:15:32Z
        )

        // A capture…
        let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x42])
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try pngBytes.write(to: workspace.appendingPathComponent("captures/capture.png"))
        }
        let screenshot = try await core.captureScreen(of: device)

        // …composed into a Finding — summary, description, Device Context…
        let finding = Finding(
            summary: "Toolbar icon is misaligned",
            description: "The share icon sits 2pt too low.",
            screenshotPNG: screenshot,
            deviceContext: DeviceContext(device: device)
        )

        // …files as exactly one issue, and the ID + link come back.
        transport.enqueue(json: #"[{"id":"6-4","name":"design-review","$type":"Tag"}]"#)
        transport.enqueue(json: #"{"id":"3-505","idReadable":"RM-421","$type":"Issue"}"#)
        transport.enqueue(json: #"[{"id":"134-31","name":"capture.png","$type":"IssueAttachment"}]"#)
        transport.enqueue(json: #"{"id":"6-4","name":"design-review","$type":"Tag"}"#)
        let filed = try await core.file(finding, in: session)
        #expect(filed == FiledIssue(
            idReadable: "RM-421",
            url: URL(string: "https://youtrack.example.com/issue/RM-421")!
        ))

        // The whole subprocess side ran: list, boot, bootstatus, open,
        // install, launch, capture (pinned command-exactly by the walking
        // skeleton scenario).
        #expect(runner.executedCommands.count == 7)

        // The exact filing requests, after the two connect requests.
        let base = "https://youtrack.example.com"
        try #require(transport.sentRequests.count == 6)
        let urls = transport.sentRequests.map(\.url?.absoluteString)
        #expect(urls[2] == "\(base)/api/tags?fields=id,name&query=design-review&$top=100")
        #expect(urls[3] == "\(base)/api/issues?fields=id,idReadable")
        #expect(urls[4] == "\(base)/api/issues/3-505/attachments?fields=id,name")
        #expect(urls[5] == "\(base)/api/issues/3-505/tags?fields=id,name")

        // Issue JSON: designer text + the metadata block stamped from the
        // ingested Build identity and the capture's Device Context.
        let issueBody = transport.sentRequests[3].httpBody.map { String(decoding: $0, as: UTF8.self) }
        #expect(issueBody == #"{"description":"The share icon sits 2pt too low.\n\n"#
            + #"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n"#
            + #"Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"#
            + #""summary":"Toolbar icon is misaligned"}"#)

        // The multipart attachment carries the captured PNG bytes.
        let attach = transport.sentRequests[4]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        var expectedBody = Data((
            "--\(boundary)\r\n"
                + "Content-Disposition: form-data; name=\"upload\"; filename=\"capture.png\"\r\n"
                + "Content-Type: image/png\r\n"
                + "\r\n"
        ).utf8)
        expectedBody.append(pngBytes)
        expectedBody.append(Data("\r\n--\(boundary)--\r\n".utf8))
        #expect(attach.httpBody == expectedBody)

        // The tag lands by ID.
        #expect(
            transport.sentRequests[5].httpBody.map { String(decoding: $0, as: UTF8.self) }
                == #"{"id":"6-4"}"#
        )
    }
}
