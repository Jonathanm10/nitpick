import Foundation
import NitpickCore
import Testing

/// Exercises the live credential store (real Keychain) and, when a server is
/// provided, the live HTTP transport. Gated behind NITPICK_LIVE_SMOKE with
/// the other tests that touch real machine state; uses a test-only Keychain
/// service so the app's real token is never disturbed.
@Suite(.enabled(if: ProcessInfo.processInfo.environment["NITPICK_LIVE_SMOKE"] == "1"))
struct YouTrackLiveTests {
    @Test("Keychain round-trip: write, read back, overwrite, delete")
    func keychainRoundTrip() throws {
        let store = KeychainCredentialStore(service: "ch.liip.nitpick.tests")
        let key = "live-test-\(UUID().uuidString)"
        defer { try? store.setSecret(nil, for: key) }

        #expect(try store.secret(for: key) == nil)
        try store.setSecret("perm:first", for: key)
        #expect(try store.secret(for: key) == "perm:first")
        try store.setSecret("perm:second", for: key)
        #expect(try store.secret(for: key) == "perm:second")
        try store.setSecret(nil, for: key)
        #expect(try store.secret(for: key) == nil)
        // Deleting an absent secret is a no-op, not an error.
        try store.setSecret(nil, for: key)
    }

    @Test(
        "real connect against the server named by NITPICK_YOUTRACK_URL",
        .enabled(if: ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_URL"] != nil
            && ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_TOKEN"] != nil)
    )
    func realConnect() async throws {
        let url = try #require(ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_URL"])
        let token = try #require(ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_TOKEN"])
        let environment = CoreEnvironment(
            subprocess: ProcessSubprocessRunner(),
            httpTransport: URLSessionHTTPTransport(),
            credentialStore: KeychainCredentialStore(service: "ch.liip.nitpick.tests")
        )
        let core = AppCore(environment: environment, workspaceDirectory: try Fixtures.makeTemporaryDirectory())
        defer { try? environment.credentialStore.setSecret(nil, for: "youtrack-token") }

        let connection = try await core.connectYouTrack(instanceURL: url, token: token)
        #expect(!connection.user.login.isEmpty)
        print("live connect: \(connection.user.fullName) (\(connection.user.login)), projects: \(connection.projects.map(\.shortName))")

        // And the relaunch path, through what connect persisted.
        let resumed = try await core.reconnectYouTrack()
        #expect(resumed == connection)
    }

    @Test(
        "real file against the server named by NITPICK_YOUTRACK_URL — creates a real issue",
        // NITPICK_LIVE_FILE is the explicit write permission: connect-only
        // smoke runs must never mutate a tracker by accident.
        .enabled(if: ProcessInfo.processInfo.environment["NITPICK_LIVE_FILE"] == "1"
            && ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_URL"] != nil
            && ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_TOKEN"] != nil
            && ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_TEST_PROJECT"] != nil)
    )
    func realFile() async throws {
        let url = try #require(ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_URL"])
        let token = try #require(ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_TOKEN"])
        let projectKey = try #require(ProcessInfo.processInfo.environment["NITPICK_YOUTRACK_TEST_PROJECT"])
        let environment = CoreEnvironment(
            subprocess: ProcessSubprocessRunner(),
            httpTransport: URLSessionHTTPTransport(),
            credentialStore: KeychainCredentialStore(service: "ch.liip.nitpick.tests")
        )
        let core = AppCore(environment: environment, workspaceDirectory: try Fixtures.makeTemporaryDirectory())
        defer { try? environment.credentialStore.setSecret(nil, for: "youtrack-token") }

        let connection = try await core.connectYouTrack(instanceURL: url, token: token)
        let project = try #require(connection.projects.first { $0.shortName == projectKey })

        // A real 1x1 transparent PNG, so the tracker shows a valid image.
        let png = try #require(Data(
            base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        ))
        let session = ReviewSession(
            build: Build(
                identity: BuildIdentity(bundleID: "ch.liip.nitpick.smoke", version: "0.0.0", buildNumber: "0"),
                appBundleURL: URL(fileURLWithPath: "/tmp/Smoke.app", isDirectory: true)
            ),
            project: project
        )
        let finding = Finding(
            summary: "nitpick live smoke — safe to delete",
            description: "Filed by YouTrackLiveTests.realFile.",
            screenshotPNG: png,
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )

        let filed = try await core.file(finding, in: session)
        #expect(!filed.idReadable.isEmpty)
        print("live file: \(filed.idReadable) at \(filed.url.absoluteString)")
    }
}
