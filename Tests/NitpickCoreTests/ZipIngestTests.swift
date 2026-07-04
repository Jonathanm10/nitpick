import Foundation
import NitpickCore
import Testing

@Suite("Zipped Build ingestion")
struct ZipIngestTests {
    let temp: URL
    let workspace: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore

    init() throws {
        temp = try Fixtures.makeTemporaryDirectory()
        workspace = temp.appendingPathComponent("workspace", isDirectory: true)
        core = AppCore(environment: .fake(subprocess: runner), workspaceDirectory: workspace)
    }

    /// Where the core is expected to extract `<name>.zip`.
    private var extractionDirectory: URL {
        workspace.appendingPathComponent("ingest/build", isDirectory: true)
    }

    private func writeZipFile() throws -> URL {
        let zipURL = temp.appendingPathComponent("build.zip")
        try Data().write(to: zipURL)
        return zipURL
    }

    @Test("a zipped Build is extracted via tar and yields its identity")
    func zippedBuild() async throws {
        let zipURL = try writeZipFile()
        let destination = extractionDirectory
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try Fixtures.writeAppBundle(
                named: "ReviewMe.app", in: destination, infoPlist: Fixtures.simulatorInfoPlist()
            )
        }

        let build = try await core.ingestBuild(at: zipURL)

        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: "/usr/bin/tar",
                arguments: ["-x", "-f", zipURL.path, "-C", destination.path]
            )
        ])
        #expect(build.identity == BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"))
        #expect(build.appBundleURL.path == destination.appendingPathComponent("ReviewMe.app").path)
    }

    @Test("an .app nested in a folder inside the archive is found")
    func nestedAppBundle() async throws {
        let zipURL = try writeZipFile()
        let destination = extractionDirectory
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            let nested = destination.appendingPathComponent("Products/Applications", isDirectory: true)
            try Fixtures.writeAppBundle(
                named: "ReviewMe.app", in: nested, infoPlist: Fixtures.simulatorInfoPlist()
            )
        }

        let build = try await core.ingestBuild(at: zipURL)

        #expect(build.identity.bundleID == "ch.liip.reviewme")
        #expect(build.appBundleURL.path.hasSuffix("Products/Applications/ReviewMe.app"))
    }

    @Test("a zip without any .app inside is rejected")
    func zipWithoutApp() async throws {
        let zipURL = try writeZipFile()
        runner.enqueue(SubprocessResult(exitCode: 0))

        await #expect(throws: BuildIngestError.noAppBundleInArchive(archiveName: "build.zip")) {
            try await core.ingestBuild(at: zipURL)
        }
    }

    @Test("an extraction failure surfaces the command and its stderr")
    func extractionFailure() async throws {
        let zipURL = try writeZipFile()
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("tar: Path contains '..'".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.ingestBuild(at: zipURL)
        }
    }

    @Test("a hidden-file zip extracts into its own contained directory")
    func hiddenFileZip() async throws {
        // A pre-existing extraction from an earlier ingest must survive.
        let earlier = workspace.appendingPathComponent("ingest/earlier", isDirectory: true)
        try FileManager.default.createDirectory(at: earlier, withIntermediateDirectories: true)

        let zipURL = temp.appendingPathComponent(".hidden.zip")
        try Data().write(to: zipURL)
        let destination = workspace.appendingPathComponent("ingest/.hidden", isDirectory: true)
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try Fixtures.writeAppBundle(
                named: "ReviewMe.app", in: destination, infoPlist: Fixtures.simulatorInfoPlist()
            )
        }

        let build = try await core.ingestBuild(at: zipURL)

        #expect(build.appBundleURL.path == destination.appendingPathComponent("ReviewMe.app").path)
        #expect(FileManager.default.fileExists(atPath: earlier.path))
    }

    @Test("a leading-dot zip name is rejected, never extracted")
    func leadingDotZip() async throws {
        // Foundation parses "..zip" as extensionless, so it must fall out as
        // an unsupported file type — long before the destructive extraction
        // path could misroute its empty stem.
        let zipURL = temp.appendingPathComponent("..zip")
        try Data().write(to: zipURL)

        await #expect(throws: BuildIngestError.unsupportedFileType(fileName: "..zip")) {
            try await core.ingestBuild(at: zipURL)
        }
        #expect(runner.executedCommands.isEmpty)
    }

    @Test("a symlinked .app pointing outside the extraction root is not ingested")
    func symlinkedAppBundle() async throws {
        // bsdtar refuses writing *through* symlinks but extracts bare
        // symlink entries, so a crafted archive can deliver `ReviewMe.app`
        // as a symlink to a directory outside the extraction root.
        let outside = temp.appendingPathComponent("outside", isDirectory: true)
        try Fixtures.writeAppBundle(
            named: "Outside.app", in: outside, infoPlist: Fixtures.simulatorInfoPlist()
        )

        let zipURL = try writeZipFile()
        let destination = extractionDirectory
        runner.enqueue(SubprocessResult(exitCode: 0)) { _ in
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(
                at: destination.appendingPathComponent("ReviewMe.app"),
                withDestinationURL: outside.appendingPathComponent("Outside.app")
            )
        }

        await #expect(throws: BuildIngestError.noAppBundleInArchive(archiveName: "build.zip")) {
            try await core.ingestBuild(at: zipURL)
        }
    }
}
