import Foundation
import NitpickCore
import Testing

@Suite("Build ingestion")
struct BuildIngestTests {
    let temp: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore

    init() throws {
        temp = try Fixtures.makeTemporaryDirectory()
        core = AppCore(
            environment: .fake(subprocess: runner),
            workspaceDirectory: temp.appendingPathComponent("workspace", isDirectory: true)
        )
    }

    @Test("a bare simulator .app yields its identity without any subprocess")
    func bareAppBundle() async throws {
        let appURL = try Fixtures.writeAppBundle(
            named: "ReviewMe.app", in: temp, infoPlist: Fixtures.simulatorInfoPlist()
        )

        let build = try await core.ingestBuild(at: appURL)

        #expect(build.identity == BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"))
        #expect(build.appBundleURL == appURL)
        #expect(runner.executedCommands.isEmpty)
    }

    @Test("a device Build is rejected as not a simulator Build")
    func deviceBuild() async throws {
        var plist = Fixtures.simulatorInfoPlist()
        plist["CFBundleSupportedPlatforms"] = ["iPhoneOS"]
        let appURL = try Fixtures.writeAppBundle(named: "ReviewMe.app", in: temp, infoPlist: plist)

        await #expect(throws: BuildIngestError.notASimulatorBuild(bundleName: "ReviewMe.app", platforms: ["iPhoneOS"])) {
            try await core.ingestBuild(at: appURL)
        }
    }

    @Test("a bundle that declares no platform is rejected")
    func platformlessBundle() async throws {
        var plist = Fixtures.simulatorInfoPlist()
        plist["CFBundleSupportedPlatforms"] = nil
        let appURL = try Fixtures.writeAppBundle(named: "ReviewMe.app", in: temp, infoPlist: plist)

        await #expect(throws: BuildIngestError.notASimulatorBuild(bundleName: "ReviewMe.app", platforms: [])) {
            try await core.ingestBuild(at: appURL)
        }
    }

    @Test("a file that is neither .app nor .zip is rejected")
    func unsupportedFile() async throws {
        let fileURL = temp.appendingPathComponent("notes.txt")
        try Data("hello".utf8).write(to: fileURL)

        await #expect(throws: BuildIngestError.unsupportedFileType(fileName: "notes.txt")) {
            try await core.ingestBuild(at: fileURL)
        }
    }

    @Test("a nonexistent path is reported, not crashed on")
    func missingFile() async throws {
        let fileURL = temp.appendingPathComponent("gone.app")

        await #expect(throws: BuildIngestError.fileNotFound(path: fileURL.path)) {
            try await core.ingestBuild(at: fileURL)
        }
    }

    @Test("an .app without Info.plist is rejected")
    func missingInfoPlist() async throws {
        let appURL = temp.appendingPathComponent("Broken.app", isDirectory: true)
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

        await #expect(throws: BuildIngestError.missingInfoPlist(bundleName: "Broken.app")) {
            try await core.ingestBuild(at: appURL)
        }
    }

    @Test("an unparseable Info.plist is rejected")
    func malformedInfoPlist() async throws {
        let appURL = temp.appendingPathComponent("Broken.app", isDirectory: true)
        try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)
        try Data("not a plist".utf8).write(to: appURL.appendingPathComponent("Info.plist"))

        await #expect(throws: BuildIngestError.malformedInfoPlist(bundleName: "Broken.app")) {
            try await core.ingestBuild(at: appURL)
        }
    }

    @Test("an Info.plist without identity keys names what is missing")
    func missingIdentityKeys() async throws {
        let appURL = try Fixtures.writeAppBundle(
            named: "Anon.app", in: temp,
            infoPlist: ["CFBundleIdentifier": "ch.liip.anon", "CFBundleSupportedPlatforms": ["iPhoneSimulator"]]
        )

        await #expect(throws: BuildIngestError.missingIdentityKeys(
            bundleName: "Anon.app", keys: ["CFBundleShortVersionString", "CFBundleVersion"]
        )) {
            try await core.ingestBuild(at: appURL)
        }
    }
}
