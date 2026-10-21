import Foundation
import NitpickCore
import Testing

/// Start or Resume review: the window button, the Review menu item, and the
/// start itself read one decision, which exists only when every fact allows it.
@Suite("Start review gate")
struct ReviewStartTests {
    static let build = IssueFilingTests.session.build
    static let picked = YouTrackProject(id: "0-77", shortName: "JW", name: "Juniper Weather")
    static let device = SimulatorDevice(udid: "A1", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)

    /// One fact at a time that forbids a start.
    enum BrokenFact: CaseIterable, Sendable {
        case noBuild, buildAlreadyRunning, filingResultHeld, noDevice, runtimeUnavailable, noProject, workRunning
    }

    static func start(breaking fact: BrokenFact? = nil, session: ReviewSession? = nil) throws -> ReviewStart? {
        var activity = ShellActivity()
        if fact == .workRunning { _ = activity.begin(.other) }
        return ReviewStart(
            build: fact == .noBuild ? nil : build,
            run: fact == .buildAlreadyRunning ? try runningReview() : nil,
            filingResult: fact == .filingResultHeld ? filedEntry : nil,
            device: fact == .noDevice ? nil
                : fact == .runtimeUnavailable ? SimulatorDevice(udid: "A1", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: false, isRuntimeAvailable: false)
                : device,
            session: session,
            selectedProject: fact == .noProject ? nil : picked,
            activity: activity
        )
    }

    static func runningReview() throws -> ReviewRun {
        let xcode = try Fixtures.writeXcode(in: Fixtures.makeTemporaryDirectory(), hostApp: .simulator)
        let host = try #require(SimulatorHostApp.discover(inDeveloperDirectory: xcode.developerDirectory))
        return ReviewRun(device: device, host: host)
    }

    static let filedEntry = HistoryEntry(
        build: build.identity,
        project: picked,
        startedAt: Date(timeIntervalSince1970: 1_783_156_532),
        findings: []
    )

    @Test("a loaded Build, an available device, and a picked project allow a start")
    func startIsAllowed() throws {
        let start = try #require(try Self.start())

        #expect(start.build == Self.build)
        #expect(start.project == Self.picked)
    }

    @Test("a restored session resumes under its pinned project, whatever the picker shows")
    func resumeUsesThePinnedProject() throws {
        let restored = IssueFilingTests.session

        let resume = try #require(try Self.start(breaking: .noProject, session: restored))
        let resumeWithOtherPick = try #require(try Self.start(session: restored))

        #expect(resume.project == restored.project)
        #expect(resumeWithOtherPick.project == restored.project)
    }

    @Test("any one forbidding fact refuses the start", arguments: BrokenFact.allCases)
    func startIsRefused(_ fact: BrokenFact) throws {
        #expect(try Self.start(breaking: fact) == nil)
    }
}
