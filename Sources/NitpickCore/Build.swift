import Foundation

/// What identifies a Build: bundle ID, version, and build number, read from
/// the bundle's Info.plist — never typed by the designer (ADR-0002).
public struct BuildIdentity: Equatable, Sendable {
    public var bundleID: String
    public var version: String
    public var buildNumber: String

    public init(bundleID: String, version: String, buildNumber: String) {
        self.bundleID = bundleID
        self.version = version
        self.buildNumber = buildNumber
    }
}

/// A specific compiled instance of the app under review, ingested from a
/// dragged .app bundle or zip archive.
public struct Build: Equatable, Sendable {
    public var identity: BuildIdentity
    /// The .app bundle on disk — for a zipped Build, inside the workspace's
    /// extraction directory.
    public var appBundleURL: URL

    public init(identity: BuildIdentity, appBundleURL: URL) {
        self.identity = identity
        self.appBundleURL = appBundleURL
    }
}

/// Why a dragged file could not become a Build. Every case carries a message
/// a designer can act on.
public enum BuildIngestError: Error, Equatable, LocalizedError {
    /// The dragged file is neither an .app bundle nor a .zip archive.
    case unsupportedFileType(fileName: String)
    /// The dragged path does not exist.
    case fileNotFound(path: String)
    /// A zip archive contained no .app bundle.
    case noAppBundleInArchive(archiveName: String)
    /// The .app bundle has no Info.plist.
    case missingInfoPlist(bundleName: String)
    /// The Info.plist exists but cannot be parsed.
    case malformedInfoPlist(bundleName: String)
    /// The Info.plist lacks required identity keys.
    case missingIdentityKeys(bundleName: String, keys: [String])
    /// The Build targets a platform other than the iOS simulator.
    case notASimulatorBuild(bundleName: String, platforms: [String])

    public var errorDescription: String? {
        switch self {
        case .unsupportedFileType(let fileName):
            return "“\(fileName)” is not a Build. Drop a simulator .app bundle or a zip containing one."
        case .fileNotFound(let path):
            return "Nothing found at \(path)."
        case .noAppBundleInArchive(let archiveName):
            return "“\(archiveName)” contains no .app bundle."
        case .missingInfoPlist(let bundleName):
            return "“\(bundleName)” has no Info.plist, so its identity can't be read. Is it a complete .app bundle?"
        case .malformedInfoPlist(let bundleName):
            return "The Info.plist in “\(bundleName)” can't be read."
        case .missingIdentityKeys(let bundleName, let keys):
            return "The Info.plist in “\(bundleName)” is missing \(keys.joined(separator: ", "))."
        case .notASimulatorBuild(let bundleName, let platforms):
            let built = platforms.isEmpty ? "an unknown platform" : platforms.joined(separator: ", ")
            return "“\(bundleName)” is built for \(built), not the iOS simulator. Ask for a simulator Build from CI."
        }
    }
}
