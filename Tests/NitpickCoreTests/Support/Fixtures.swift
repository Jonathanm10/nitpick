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
}
