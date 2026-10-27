import Foundation
@testable import NitpickCore
import Testing

/// The golden files the TypeScript port in `core/` is written against
/// (`core/test/golden/README.md`): metadata blocks, Issue and Feedback
/// descriptions, the stored schema v1 JSON and the filed images, each next
/// to a description of its input. Testable import: the stored shapes and
/// the descriptions are internal, and the exact bytes are the contract.
@Suite("Golden files for the TypeScript port")
struct GoldenFileTests {
    static func uuid(_ number: Int) -> UUID {
        UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", number))!
    }

    static let figmaFile = URL(string: "https://www.figma.com/file/abc123/ReviewMe")!

    // MARK: - Metadata block

    enum MetadataBlockGolden: String, CaseIterable, Sendable {
        case minimal
        case accessibility
        case designReference = "design-reference"
        case accessibilityAndDesignReference = "accessibility-and-design-reference"
        case sessionDesignReference = "session-design-reference"
        case findingDesignReferenceOverridesSession = "finding-design-reference-overrides-session"
        case deviceSettingsDefault = "device-settings-default"
        case deviceSettingsDynamicTypeAndDarkMode = "device-settings-dynamic-type-and-dark-mode"
        case deviceSettingsDynamicTypeAlone = "device-settings-dynamic-type-alone"
        case deviceSettingsIncreaseContrast = "device-settings-increase-contrast"
        case deviceSettingsIncreaseContrastAlone = "device-settings-increase-contrast-alone"
        /// A real session starts mid-second; the session line shows whole seconds.
        case fractionalSessionStart = "fractional-session-start"

        var path: String { "metadata-block/\(rawValue).txt" }

        var session: ReviewSession {
            switch self {
            case .sessionDesignReference, .findingDesignReferenceOverridesSession:
                MetadataBlockTests.sessionWithReference
            case .fractionalSessionStart:
                ReviewSession(
                    build: MetadataBlockTests.session.build,
                    project: MetadataBlockTests.session.project,
                    startedAt: MetadataBlockTests.session.startedAt.addingTimeInterval(0.75)
                )
            default:
                MetadataBlockTests.session
            }
        }

        /// The observed settings a Device Context was stamped from, for the
        /// cases MetadataBlockTests builds that way.
        var deviceSettings: DeviceSettings? {
            switch self {
            case .deviceSettingsDefault: DeviceSettings()
            case .deviceSettingsDynamicTypeAndDarkMode:
                DeviceSettings(dynamicTypeSize: .accessibilityLarge, appearance: .dark)
            case .deviceSettingsDynamicTypeAlone: DeviceSettings(dynamicTypeSize: .extraLarge)
            case .deviceSettingsIncreaseContrast:
                DeviceSettings(dynamicTypeSize: .accessibilityLarge, appearance: .dark, increaseContrast: true)
            case .deviceSettingsIncreaseContrastAlone: DeviceSettings(increaseContrast: true)
            default: nil
            }
        }

        var finding: Finding {
            switch self {
            case .accessibility:
                return MetadataBlockTests.finding(accessibilitySettings: ["Dynamic Type XL", "Dark Mode"])
            case .designReference, .findingDesignReferenceOverridesSession:
                return MetadataBlockTests.finding(designReference: GoldenFileTests.figmaFile)
            case .accessibilityAndDesignReference:
                return MetadataBlockTests.finding(
                    accessibilitySettings: ["Dynamic Type XL"], designReference: GoldenFileTests.figmaFile
                )
            default:
                var finding = MetadataBlockTests.finding()
                if let deviceSettings {
                    finding.deviceContext = DeviceContext(device: MetadataBlockTests.device, settings: deviceSettings)
                }
                return finding
            }
        }
    }

    struct MetadataBlockInput: Encodable {
        var session: GoldenDescription.Session
        var finding: GoldenDescription.Finding
        var deviceSettings: GoldenDescription.DeviceSettings?
    }

    @Test("metadata block", arguments: MetadataBlockGolden.allCases)
    func metadataBlock(_ golden: MetadataBlockGolden) throws {
        try GoldenFiles.expectInput(
            MetadataBlockInput(
                session: GoldenDescription.Session(golden.session),
                finding: GoldenDescription.Finding(golden.finding),
                deviceSettings: golden.deviceSettings.map(GoldenDescription.DeviceSettings.init)
            ),
            describing: golden.path
        )
        try GoldenFiles.expect(Data(golden.session.metadataBlock(for: golden.finding).utf8), matches: golden.path)
    }

    static let dynamicTypeNamesPath = "metadata-block/dynamic-type-names.json"

    @Test("every Dynamic Type size's stamp name, in size order")
    func dynamicTypeNames() throws {
        let sizes = DeviceSettings.DynamicTypeSize.allCases
        try GoldenFiles.expectInput(sizes.map(\.rawValue), describing: Self.dynamicTypeNamesPath)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        try GoldenFiles.expect(
            encoder.encode(sizes.map(\.displayName)) + Data("\n".utf8),
            matches: Self.dynamicTypeNamesPath
        )
    }

    // MARK: - Issue description

    enum IssueDescriptionGolden: String, CaseIterable, Sendable {
        /// Surrounding whitespace is trimmed; inner newlines stay.
        case withDesignerText = "with-designer-text"
        /// Whitespace only counts as no text: the block alone.
        case withoutDesignerText = "without-designer-text"

        var path: String { "issue-description/\(rawValue).txt" }

        var finding: Finding {
            var finding = MetadataBlockTests.finding(accessibilitySettings: ["Dark Mode"])
            switch self {
            case .withDesignerText:
                finding.description = "  The primary button is #FF0000, the design says #E64545.\nCompare with the Figma frame.\n\n"
            case .withoutDesignerText:
                finding.description = " \n\t "
            }
            return finding
        }
    }

    struct IssueDescriptionInput: Encodable {
        var session: GoldenDescription.Session
        var finding: GoldenDescription.Finding
    }

    @Test("issue description", arguments: IssueDescriptionGolden.allCases)
    func issueDescription(_ golden: IssueDescriptionGolden) throws {
        let session = MetadataBlockTests.sessionWithReference
        try GoldenFiles.expectInput(
            IssueDescriptionInput(
                session: GoldenDescription.Session(session),
                finding: GoldenDescription.Finding(golden.finding)
            ),
            describing: golden.path
        )
        try GoldenFiles.expect(Data(session.issueDescription(for: golden.finding).utf8), matches: golden.path)
    }

    // MARK: - Feedback description

    enum FeedbackDescriptionGolden: String, CaseIterable, Sendable {
        case withoutReviewSession = "without-review-session"
        case withReviewSession = "with-review-session"
        /// No description and no versions read: the Environment section alone.
        case withoutDescription = "without-description"

        var path: String { "feedback-description/\(rawValue).txt" }

        var feedback: Feedback {
            switch self {
            case .withoutReviewSession:
                Feedback(
                    kind: .bug,
                    title: "Tray loses focus after capture",
                    description: "After capturing, the summary field is not focused.",
                    environment: Feedback.Environment(
                        nitpickVersion: "1.4.0", nitpickBuild: "57",
                        macOS: "Version 26.1 (Build 25B78)", xcode: "26.1 (17B55)"
                    )
                )
            case .withReviewSession:
                Feedback(
                    kind: .improvement,
                    title: "Show the Build in the window title",
                    description: "  Name the device too.\nIt helps with two windows open.\n",
                    environment: Feedback.Environment(
                        nitpickVersion: "1.4.0", nitpickBuild: "57",
                        macOS: "Version 26.1 (Build 25B78)", xcode: "26.1 (17B55)",
                        review: Feedback.Environment.ReviewContext(
                            build: MetadataBlockTests.session.build.identity,
                            hostName: "Simulator",
                            device: SimulatorDevice(
                                udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.1", isBooted: true
                            )
                        )
                    )
                )
            case .withoutDescription:
                Feedback(
                    kind: .bug,
                    title: "Capture does nothing",
                    description: " \n",
                    environment: Feedback.Environment(
                        nitpickVersion: nil, nitpickBuild: nil, macOS: "Version 26.1 (Build 25B78)", xcode: nil
                    )
                )
            }
        }
    }

    @Test("Feedback description", arguments: FeedbackDescriptionGolden.allCases)
    func feedbackDescription(_ golden: FeedbackDescriptionGolden) throws {
        try GoldenFiles.expectInput(GoldenDescription.Feedback(golden.feedback), describing: golden.path)
        try GoldenFiles.expect(Data(golden.feedback.issueDescription.utf8), matches: golden.path)
    }

    // MARK: - Stored open session (schema v1)

    /// A start moment at the precision `Date()` gives, as every real
    /// session has: 2026-07-04T09:15:32.473Z.
    static let storedStartedAt = Date(timeIntervalSinceReferenceDate: 804_849_332.472_906_1)

    static func storedSession(designReference: URL? = nil, tray: [TrayItem]) -> ReviewSession {
        var session = ReviewSession(
            build: MetadataBlockTests.session.build,
            project: MetadataBlockTests.session.project,
            startedAt: storedStartedAt,
            designReference: designReference
        )
        session.tray = tray
        return session
    }

    static func item(
        _ number: Int,
        _ finding: Finding,
        _ filingProgress: FilingProgress = .notStarted
    ) -> TrayItem {
        TrayItem(id: uuid(number), finding: finding, filingProgress: filingProgress)
    }

    static func finding(_ summary: String) -> Finding {
        MetadataBlockTests.finding().with { $0.summary = summary }
    }

    static func filedIssue(_ idReadable: String) -> FiledIssue {
        FiledIssue(idReadable: idReadable, url: URL(string: "https://youtrack.example.com/yt/issue/\(idReadable)")!)
    }

    enum StoredSessionGolden: String, CaseIterable, Sendable {
        /// One tray item in each filing state.
        case filingProgress = "filing-progress"
        /// Every Annotation kind and colour, with fractional and negative
        /// coordinates, plus escaping in text and URLs.
        case annotations
        /// Type, Priority and Assignee each set alone, and none set.
        case triage
        /// First versions of a PNG and a JPEG snapshot (`dataVersion` equal
        /// to `id`), and a Finding with none.
        case designSnapshots = "design-snapshots"
        /// A replaced snapshot: same `id`, a new `dataVersion`.
        case designSnapshotsReplaced = "design-snapshots-replaced"

        var path: String { "stored-session/\(rawValue).json" }

        func session() throws -> ReviewSession {
            switch self {
            case .filingProgress:
                return GoldenFileTests.storedSession(tray: [
                    item(1, finding("Button color is off")),
                    item(2, finding("Label truncates"), .issueCreated(issueID: "3-506", idReadable: "RM-422")),
                    item(3, finding("Icon is blurry"), .attachmentsUploaded(issueID: "3-507", idReadable: "RM-423")),
                    item(4, finding("Spacing is off"), .reviewTagged(issueID: "3-508", idReadable: "RM-424")),
                    item(5, finding("Wrong font weight"), .filed(filedIssue("RM-425"))),
                ])
            case .annotations:
                var annotated = finding("Header spacing is off")
                annotated.description = "Spacing is 2pt off — compare with \"Header\".\nSee the second row too."
                annotated.deviceContext = DeviceContext(
                    deviceModel: "iPad Pro 13-inch (M4)", osName: "iOS 26.4",
                    accessibilitySettings: ["Dynamic Type AX2", "Dark Mode"]
                )
                annotated.designReference = URL(string: "https://www.figma.com/design/abc123/ReviewMe?node-id=12-34")!
                for annotation in [
                    Annotation(.pen(points: [
                        CGPoint(x: 60, y: 120), CGPoint(x: 90.5, y: 180.25), CGPoint(x: 140, y: 150),
                    ])),
                    Annotation(.arrow(from: CGPoint(x: 240, y: 400), to: CGPoint(x: 120.75, y: 300)), color: .yellow),
                    Annotation(.rectangle(CGRect(x: 60, y: 500, width: 240, height: 160)), color: .green),
                    Annotation(.label("2pt off — 8/10 \"tight\"", at: CGPoint(x: 100, y: 700)), color: .blue),
                    Annotation(.pen(points: [CGPoint(x: -4, y: 12), CGPoint(x: 10, y: -3.5)]), color: .black),
                    Annotation(.rectangle(CGRect(x: 0.5, y: 0.5, width: 33.25, height: 12)), color: .white),
                ] {
                    annotated.add(annotation)
                }
                return GoldenFileTests.storedSession(
                    designReference: URL(string: "https://www.figma.com/file/sess42/ReviewMe")!,
                    tray: [item(10, annotated)]
                )
            case .triage:
                return GoldenFileTests.storedSession(tray: [
                    item(20, finding("No triage set")),
                    item(21, finding("Add a skeleton while loading").with { $0.type = .improvement }),
                    item(22, finding("Checkout button is hidden").with { $0.priority = FindingPriority(name: "Critical") }),
                    item(23, finding("Avatar is cropped").with {
                        $0.assignee = FindingAssignee(login: "mira.sol", fullName: "Mira Sol")
                    }),
                ])
            case .designSnapshots:
                var withSnapshots = finding("Button style differs from the design")
                withSnapshots.designSnapshots = [
                    DesignSnapshot(
                        id: uuid(30), name: "Button – default.png", mediaType: .png,
                        data: try ImageFixtures.solidPNG(width: 8, height: 8)
                    ),
                    DesignSnapshot(
                        id: uuid(31), name: "Header.jpg", mediaType: .jpeg,
                        data: try ImageFixtures.solidJPEG(width: 8, height: 8)
                    ),
                ]
                return GoldenFileTests.storedSession(tray: [
                    item(32, withSnapshots),
                    item(33, finding("No snapshots here")),
                ])
            case .designSnapshotsReplaced:
                var replaced = finding("Tab bar icons differ")
                replaced.designSnapshots = [
                    DesignSnapshot(
                        id: uuid(40), dataVersion: uuid(41), name: "Tab bar.png", mediaType: .png,
                        data: try ImageFixtures.solidPNG(width: 8, height: 8, white: 0.4)
                    ),
                ]
                return GoldenFileTests.storedSession(tray: [item(42, replaced)])
            }
        }
    }

    struct StoredSessionInput: Encodable {
        var session: GoldenDescription.Session
        /// Set on a decode-only golden: the golden its value encodes to.
        var reencodesAs: String?
    }

    /// The open-session manifest `saveOpenSession` writes for `session`,
    /// with the workspace and core that wrote it.
    static func savedManifest(of session: ReviewSession) throws -> (core: AppCore, manifest: URL, data: Data) {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = DurabilityTests.relaunchedCore(workspace: workspace)
        try core.saveOpenSession(session)
        let manifest = workspace.appendingPathComponent("open-session/session.json")
        return (core, manifest, try Data(contentsOf: manifest))
    }

    @Test("stored open session", arguments: StoredSessionGolden.allCases)
    func storedSession(_ golden: StoredSessionGolden) throws {
        let session = try golden.session()
        let (core, manifest, written) = try Self.savedManifest(of: session)
        try GoldenFiles.expectInput(
            StoredSessionInput(session: GoldenDescription.Session(session)), describing: golden.path
        )
        try GoldenFiles.expect(written, matches: golden.path)

        // Decoding the golden gives back the session, and saving that
        // session gives back the golden's bytes.
        guard !GoldenFiles.isRecording, try GoldenFiles.read(golden.path) == written else { return }
        try written.write(to: manifest)
        let loaded = try #require(try core.loadOpenSession())
        #expect(loaded == session)
        try core.saveOpenSession(loaded)
        #expect(try Data(contentsOf: manifest) == written)
    }

    static let withoutDataVersionPath = "stored-session/design-snapshots-without-data-version.json"

    /// A manifest from before Replace minted data versions: the
    /// `design-snapshots` golden without its `dataVersion` keys, as that
    /// older build wrote it. Decode-only: the decoded value encodes back to
    /// `design-snapshots.json`.
    @Test("stored open session without dataVersion decodes to the design-snapshots session")
    func storedSessionWithoutDataVersion() throws {
        let session = try StoredSessionGolden.designSnapshots.session()
        let (core, manifest, written) = try Self.savedManifest(of: session)
        let modern = String(decoding: written, as: UTF8.self)
        let dataVersionKey = /"dataVersion":"[0-9A-F-]{36}",/
        try #require(modern.matches(of: dataVersionKey).count == 2)
        let legacy = Data(modern.replacing(dataVersionKey, with: "").utf8)

        try GoldenFiles.expectInput(
            StoredSessionInput(
                session: GoldenDescription.Session(session),
                reencodesAs: "design-snapshots.json"
            ),
            describing: Self.withoutDataVersionPath
        )
        try GoldenFiles.expect(legacy, matches: Self.withoutDataVersionPath)

        guard !GoldenFiles.isRecording, try GoldenFiles.read(Self.withoutDataVersionPath) == legacy else { return }
        try legacy.write(to: manifest)
        let loaded = try #require(try core.loadOpenSession())
        #expect(loaded == session)
        try core.saveOpenSession(loaded)
        #expect(try Data(contentsOf: manifest) == written)
    }

    // MARK: - Stored History entry (schema v1)

    static let historyEntryPath = "stored-history-entry/history-entry.json"

    struct HistoryEntryInput: Encodable {
        var historyEntry: GoldenDescription.HistoryEntry
    }

    @Test("stored History entry")
    func historyEntry() throws {
        let workspace = try Fixtures.makeTemporaryDirectory()
        let core = DurabilityTests.relaunchedCore(workspace: workspace)
        let referenced = Self.finding("Button color is off").with {
            $0.designReference = Self.figmaFile
            $0.deviceContext = DeviceContext(
                deviceModel: "iPhone 17 Pro", osName: "iOS 26.4",
                accessibilitySettings: ["Dynamic Type XL", "Increase Contrast"]
            )
        }
        try core.recordInHistory(Self.storedSession(tray: [
            Self.item(50, referenced, .filed(Self.filedIssue("RM-421"))),
            Self.item(51, Self.finding("Label truncates").with { $0.description = "" }, .filed(Self.filedIssue("RM-422"))),
        ]))

        let files = try FileManager.default.contentsOfDirectory(
            at: workspace.appendingPathComponent("history"), includingPropertiesForKeys: nil
        )
        try #require(files.count == 1)
        let entry = try #require(try core.sessionHistory().first)
        try GoldenFiles.expectInput(
            HistoryEntryInput(historyEntry: GoldenDescription.HistoryEntry(entry)), describing: Self.historyEntryPath
        )
        try GoldenFiles.expect(Data(contentsOf: files[0]), matches: Self.historyEntryPath)
    }

    // MARK: - Images

    static let capturePath = "images/capture.png"
    static let passthroughPath = "images/unannotated-passthrough.png"
    static let flattenedPath = "images/flattened-four-tools.png"

    struct ImageInput: Encodable {
        /// The capture's file name, next to the golden.
        var capture: String
        var annotations: [GoldenDescription.Annotation]

        init(_ finding: Finding) {
            capture = (GoldenFileTests.capturePath as NSString).lastPathComponent
            annotations = finding.annotations.map(GoldenDescription.Annotation.init)
        }
    }

    /// Both images start from one committed capture, so the passthrough is
    /// checked against bytes no encoder rewrote. The flattened image keeps
    /// the snapshot rule (`ImageFixtures.expectMatchesSnapshot`).
    @Test("an unannotated capture passes through byte for byte, and all four tools flatten as pinned")
    func images() throws {
        let capture: Data
        if GoldenFiles.isRecording {
            capture = try ImageFixtures.solidPNG(width: 480, height: 960)
            try FileManager.default.createDirectory(
                at: GoldenFiles.url(Self.capturePath).deletingLastPathComponent(), withIntermediateDirectories: true
            )
            try capture.write(to: GoldenFiles.url(Self.capturePath), options: .atomic)
        } else {
            capture = try GoldenFiles.read(Self.capturePath)
        }

        var finding = AnnotationFlatteningTests.finding(screenshotPNG: capture)
        try GoldenFiles.expectInput(ImageInput(finding), describing: Self.passthroughPath)
        try GoldenFiles.expect(finding.annotatedScreenshotPNG(), matches: Self.passthroughPath)

        AnnotationFlatteningTests.annotateWithAllFourTools(&finding)
        try GoldenFiles.expectInput(ImageInput(finding), describing: Self.flattenedPath)
        try ImageFixtures.expectMatchesSnapshot(finding.annotatedScreenshotPNG(), named: "flattened-four-tools")
    }

    // MARK: - Completeness

    @Test(
        "every file under core/test/golden is a golden this suite checks, its input, or the README",
        .disabled(if: GoldenFiles.isRecording, "a recording run writes files while this lists them")
    )
    func noStrayFiles() throws {
        var expected: Set<String> = ["README.md", Self.capturePath]
        func golden(_ path: String) {
            expected.insert(path)
            expected.insert(GoldenFiles.inputPath(for: path))
        }
        MetadataBlockGolden.allCases.forEach { golden($0.path) }
        golden(Self.dynamicTypeNamesPath)
        IssueDescriptionGolden.allCases.forEach { golden($0.path) }
        FeedbackDescriptionGolden.allCases.forEach { golden($0.path) }
        StoredSessionGolden.allCases.forEach { golden($0.path) }
        golden(Self.withoutDataVersionPath)
        golden(Self.historyEntryPath)
        golden(Self.passthroughPath)
        golden(Self.flattenedPath)

        let root = GoldenFiles.directory.resolvingSymlinksInPath().path + "/"
        let present = try #require(FileManager.default.enumerator(
            at: GoldenFiles.directory, includingPropertiesForKeys: [.isRegularFileKey], options: .skipsHiddenFiles
        ))
        .compactMap { $0 as? URL }
        .filter { try $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true }
        .map { String($0.resolvingSymlinksInPath().path.dropFirst(root.count)) }

        let stray = Set(present).subtracting(expected).sorted()
        #expect(stray.isEmpty, "No golden test checks \(stray.joined(separator: ", ")) in core/test/golden")
    }
}

extension Finding {
    fileprivate func with(_ edit: (inout Finding) -> Void) -> Finding {
        var copy = self
        edit(&copy)
        return copy
    }
}
