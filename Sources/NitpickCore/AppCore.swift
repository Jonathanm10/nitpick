import Foundation

/// The app core: the one deep module behind which session lifecycle, Build
/// ingestion, capture, and (in later slices) filing live. The SwiftUI shell
/// talks to nothing else.
public struct AppCore: Sendable {
    public var environment: CoreEnvironment
    /// Where the core keeps its on-disk working state: extracted Builds,
    /// captures, and (in later slices) persisted sessions.
    public var workspaceDirectory: URL

    public init(environment: CoreEnvironment, workspaceDirectory: URL) {
        self.environment = environment
        self.workspaceDirectory = workspaceDirectory
    }

    /// Ingests a dragged Build — a bare simulator .app bundle or a zip
    /// containing one — and reads its identity from Info.plist.
    public func ingestBuild(at url: URL) async throws -> Build {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw BuildIngestError.fileNotFound(path: url.path)
        }
        switch url.pathExtension.lowercased() {
        case "app":
            return try readBuild(fromAppBundle: url)
        case "zip":
            return try await readBuild(fromArchive: url)
        default:
            throw BuildIngestError.unsupportedFileType(fileName: url.lastPathComponent)
        }
    }
}
