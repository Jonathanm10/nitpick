import NitpickCore
import Testing

/// Start or Resume review exists only when every fact allows it.
@Suite("Start review gate")
struct ReviewStartTests {
    static let build = IssueFilingTests.session.build
    static let picked = YouTrackProject(id: "0-77", shortName: "JW", name: "Juniper Weather")
    static let device = SimulatorDevice(udid: "A1", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)

    enum BrokenFact: CaseIterable, Sendable {
        case noBuild, buildAlreadyRunning, filingResultHeld, noDevice, runtimeUnavailable, noProject, workRunning
    }

    static func start(breaking fact: BrokenFact? = nil, session: ReviewSession? = nil) -> ReviewStart? {
        ReviewStart(
            build: fact == .noBuild ? nil : build,
            isReviewing: fact == .buildAlreadyRunning,
            holdsFilingResult: fact == .filingResultHeld,
            device: fact == .noDevice ? nil
                : fact == .runtimeUnavailable ? SimulatorDevice(udid: "A1", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: false, isRuntimeAvailable: false)
                : device,
            session: session,
            selectedProject: fact == .noProject ? nil : picked,
            isBusy: fact == .workRunning
        )
    }

    @Test("a loaded Build, an available device, and a picked project allow a start")
    func startIsAllowed() throws {
        let start = try #require(Self.start())

        #expect(start.build == Self.build)
        #expect(start.project == Self.picked)
    }

    @Test("a restored session resumes under its pinned project, whatever the picker shows")
    func resumeUsesThePinnedProject() throws {
        let restored = IssueFilingTests.session

        let resume = try #require(Self.start(breaking: .noProject, session: restored))
        let resumeWithOtherPick = try #require(Self.start(session: restored))

        #expect(resume.project == restored.project)
        #expect(resumeWithOtherPick.project == restored.project)
    }

    @Test("any one forbidding fact refuses the start", arguments: BrokenFact.allCases)
    func startIsRefused(_ fact: BrokenFact) {
        #expect(Self.start(breaking: fact) == nil)
    }
}
