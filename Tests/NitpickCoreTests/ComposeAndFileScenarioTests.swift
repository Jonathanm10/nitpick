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
        for _ in 0..<7 { runner.enqueue(SubprocessResult(exitCode: 0)) }
        try await core.launch(build, on: device)

        // …and starts the Review Session by choosing the project — once.
        let project = try #require(connection.projects.first { $0.shortName == "RM" })
        let session = ReviewSession(
            build: build, project: project,
            startedAt: Date(timeIntervalSince1970: 1_783_156_532)  // 2026-07-04T09:15:32Z
        )

        // A capture — preceded by its booted re-check…
        let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x42])
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data(Fixtures.deviceListJSON(udid: device.udid, name: device.name, state: "Booted").utf8)
        ))
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
        transport.enqueue(json: #"[{"id":"6-5","name":"nitpick-type:bug","$type":"Tag"}]"#)
        transport.enqueue(json: #"{"id":"3-505","idReadable":"RM-421","$type":"Issue"}"#)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: #"{"id":"6-4","name":"design-review","$type":"Tag"}"#)
        transport.enqueue(json: #"{"id":"6-5","name":"nitpick-type:bug","$type":"Tag"}"#)
        let filed = try await core.file(finding, in: session)
        #expect(filed == FiledIssue(
            idReadable: "RM-421",
            url: URL(string: "https://youtrack.example.com/issue/RM-421")!
        ))

        // The whole subprocess side ran: list, boot, bootstatus, open,
        // the two Device Settings applications, install, launch, the
        // capture's booted re-check, capture (pinned command-exactly by
        // the walking skeleton scenario).
        #expect(runner.executedCommands.count == 10)

        // The exact filing requests, after the two connect requests.
        let base = "https://youtrack.example.com"
        try #require(transport.sentRequests.count == 8)
        let urls = transport.sentRequests.map(\.url?.absoluteString)
        #expect(urls[2] == "\(base)/api/tags?fields=id,name&query=design-review&$top=100")
        #expect(urls[3] == "\(base)/api/tags?fields=id,name&query=nitpick-type:bug&$top=100")
        #expect(urls[4] == "\(base)/api/issues?fields=id,idReadable")
        #expect(urls[5] == "\(base)/api/issues/3-505/attachments?fields=id,name")
        #expect(urls[6] == "\(base)/api/issues/3-505/tags?fields=id,name")
        #expect(urls[7] == "\(base)/api/issues/3-505/tags?fields=id,name")

        // Issue JSON: designer text + the metadata block stamped from the
        // ingested Build identity and the capture's Device Context.
        let issueBody = transport.sentRequests[4].httpBody.map { String(decoding: $0, as: UTF8.self) }
        #expect(issueBody == #"{"description":"The share icon sits 2pt too low.\n\n"#
            + #"---\nApp: ch.liip.reviewme 2.1.0 (421)\nDevice: iPhone 17 Pro — iOS 26.4\n"#
            + #"Filed with nitpick — session 2026-07-04T09:15:32Z","project":{"id":"0-12"},"#
            + #""summary":"Toolbar icon is misaligned"}"#)

        // The multipart attachment carries both variants; unannotated, the
        // annotated variant is the captured bytes unchanged.
        let attach = transport.sentRequests[5]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        #expect(attach.httpBody == IssueFilingTests.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: pngBytes),
            (fileName: "original.png", data: pngBytes),
        ]))

        // The design-review tag lands by ID (the Type tag follows it).
        #expect(
            transport.sentRequests[6].httpBody.map { String(decoding: $0, as: UTF8.self) }
                == #"{"id":"6-4"}"#
        )
    }

    @Test("Annotations stay editable until filing; the filed issue carries annotated and clean original")
    func annotateEditUndoAndFile() async throws {
        let transport = FakeHTTPTransport()
        let core = AppCore(
            environment: .fake(httpTransport: transport, credentialStore: FakeCredentialStore()),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )
        transport.enqueue(json: YouTrackConnectionTests.userJSON)
        transport.enqueue(json: YouTrackConnectionTests.projectsJSON)
        let connection = try await core.connectYouTrack(
            instanceURL: "https://youtrack.example.com", token: "perm:designer-token"
        )
        let project = try #require(connection.projects.first { $0.shortName == "RM" })
        let session = ReviewSession(
            build: Build(
                identity: BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"),
                appBundleURL: URL(fileURLWithPath: "/tmp/ReviewMe.app", isDirectory: true)
            ),
            project: project
        )

        // A composed Finding on a real capture-sized image…
        let cleanPNG = try ImageFixtures.solidPNG(width: 480, height: 960)
        var finding = Finding(
            summary: "Share icon is misaligned",
            description: "It sits 2pt too low.",
            screenshotPNG: cleanPNG,
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )

        // …marked up with all four tools…
        finding.add(Annotation(.pen(points: [CGPoint(x: 40, y: 80), CGPoint(x: 120, y: 160)])))
        finding.add(Annotation(.arrow(from: CGPoint(x: 300, y: 500), to: CGPoint(x: 200, y: 420)), color: .blue))
        finding.add(Annotation(.rectangle(CGRect(x: 80, y: 300, width: 200, height: 120)), color: .yellow))
        finding.add(Annotation(.label("2pt off", at: CGPoint(x: 90, y: 440)), color: .white))
        #expect(finding.annotations.count == 4)

        // …then refined while reviewing: the label moves, a stray pen
        // stroke is undone and the label move survives it —
        let movedLabel = Annotation(.label("2pt off", at: CGPoint(x: 90, y: 470)), color: .white)
        finding.replaceAnnotation(at: 3, with: movedLabel)
        finding.add(Annotation(.pen(points: [CGPoint(x: 10, y: 10), CGPoint(x: 12, y: 12)])))
        finding.undo()
        #expect(finding.annotations.count == 4)
        #expect(finding.annotations[3] == movedLabel)

        // — and one undo too many is taken back with redo.
        finding.undo()
        #expect(finding.annotations[3].shape == .label("2pt off", at: CGPoint(x: 90, y: 440)))
        finding.redo()
        #expect(finding.annotations[3] == movedLabel)

        // Filing freezes exactly this state into the annotated attachment,
        // next to the untouched original.
        transport.enqueue(json: IssueFilingTests.existingTagJSON)
        transport.enqueue(json: IssueFilingTests.existingTypeTagJSON)
        transport.enqueue(json: IssueFilingTests.createdIssueJSON)
        transport.enqueue(json: IssueFilingTests.attachmentsJSON)
        transport.enqueue(json: IssueFilingTests.appliedTagJSON)
        transport.enqueue(json: IssueFilingTests.appliedTypeTagJSON)
        _ = try await core.file(finding, in: session)

        let attach = transport.sentRequests[5]
        let contentType = try #require(attach.value(forHTTPHeaderField: "Content-Type"))
        let boundary = try #require(contentType.wholeMatch(of: /multipart\/form-data; boundary=(nitpick-[0-9A-F-]+)/)?.1)
        let flattened = try finding.annotatedScreenshotPNG()
        #expect(flattened != cleanPNG)
        #expect(attach.httpBody == IssueFilingTests.multipartBody(boundary: boundary, files: [
            (fileName: "annotated.png", data: flattened),
            (fileName: "original.png", data: cleanPNG),
        ]))
    }
}
