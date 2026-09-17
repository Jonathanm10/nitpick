import Foundation

enum Fixtures {
    /// A fresh directory under the system temp dir, unique per call, in
    /// canonical form (/private/var, not /var) so path assertions compare
    /// equal against filesystem-enumerated URLs.
    static func makeTemporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("nitpick-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        guard let canonical = try url.resourceValues(forKeys: [.canonicalPathKey]).canonicalPath else {
            return url
        }
        return URL(fileURLWithPath: canonical, isDirectory: true)
    }

    /// `simctl list devices --json` output holding a single device in the
    /// given state — what the capture preflight consumes.
    static func deviceListJSON(udid: String, name: String, state: String) -> String {
        """
        {
          "devices" : {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-4" : [
              {
                "udid" : "\(udid)",
                "name" : "\(name)",
                "state" : "\(state)",
                "isAvailable" : true
              }
            ]
          }
        }
        """
    }

    /// The Info.plist of a CI-produced simulator Build with the given identity.
    static func simulatorInfoPlist(
        bundleID: String = "ch.liip.reviewme",
        version: String = "2.1.0",
        buildNumber: String = "421"
    ) -> [String: Any] {
        [
            "CFBundleIdentifier": bundleID,
            "CFBundleShortVersionString": version,
            "CFBundleVersion": buildNumber,
            "CFBundleSupportedPlatforms": ["iPhoneSimulator"],
        ]
    }

    /// Writes `<directory>/<name>` as an .app bundle containing the given
    /// Info.plist. Returns the bundle URL.
    @discardableResult
    static func writeAppBundle(
        named name: String,
        in directory: URL,
        infoPlist: [String: Any]
    ) throws -> URL {
        let bundleURL = directory.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(
            fromPropertyList: infoPlist, format: .xml, options: 0
        )
        try data.write(to: bundleURL.appendingPathComponent("Info.plist"))
        return bundleURL
    }

    /// Which host app a fixture Xcode ships.
    enum FixtureHostApp {
        /// `Contents/Developer/Applications/Simulator.app`, `com.apple.iphonesimulator`.
        case simulator
        /// `Contents/Applications/DeviceHub.app`, `com.apple.dt.Devices`.
        case deviceHub
        /// Neither bundle — an Xcode whose host app is missing.
        case none
    }

    struct FixtureXcode {
        /// What the fake `xcode-select -p` should print.
        var developerDirectory: URL
        /// The bundle `launch` is expected to `open`; nil for `.none`.
        var hostAppURL: URL?
    }

    /// Writes a minimal `Xcode.app` tree under `directory` with the host
    /// app at its real relative location and an Info.plist carrying the
    /// real bundle id. Sequence tests script `xcode-select -p` to print
    /// `developerDirectory` and assert `open -a <hostAppURL>`.
    static func writeXcode(in directory: URL, hostApp: FixtureHostApp) throws -> FixtureXcode {
        let xcodeApp = directory.appendingPathComponent("Xcode.app", isDirectory: true)
        let contents = xcodeApp.appendingPathComponent("Contents", isDirectory: true)
        let developerDirectory = contents.appendingPathComponent("Developer", isDirectory: true)
        try FileManager.default.createDirectory(at: developerDirectory, withIntermediateDirectories: true)

        let hostAppURL: URL?
        switch hostApp {
        case .simulator:
            hostAppURL = try writeAppBundle(
                named: "Simulator.app",
                in: developerDirectory.appendingPathComponent("Applications", isDirectory: true),
                infoPlist: hostAppInfoPlist(
                    bundleIdentifier: "com.apple.iphonesimulator",
                    displayName: "Simulator"
                )
            )
        case .deviceHub:
            hostAppURL = try writeAppBundle(
                named: "DeviceHub.app",
                in: contents.appendingPathComponent("Applications", isDirectory: true),
                infoPlist: hostAppInfoPlist(
                    bundleIdentifier: "com.apple.dt.Devices",
                    displayName: "DeviceHub"
                )
            )
        case .none:
            hostAppURL = nil
        }

        return FixtureXcode(developerDirectory: developerDirectory, hostAppURL: hostAppURL)
    }

    private static func hostAppInfoPlist(bundleIdentifier: String, displayName: String) -> [String: Any] {
        [
            "CFBundleIdentifier": bundleIdentifier,
            "CFBundleDisplayName": displayName,
            "CFBundleName": displayName,
        ]
    }
}
