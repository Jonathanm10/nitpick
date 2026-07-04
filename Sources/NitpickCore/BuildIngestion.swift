import Foundation

extension AppCore {
    /// Extracts a zipped Build into the workspace and reads the .app inside.
    func readBuild(fromArchive archiveURL: URL) async throws -> Build {
        // The destination is wiped before extraction, so it must never
        // resolve to the ingest root (or above). Foundation already parses
        // leading-dot names (".zip", "..zip") as extensionless — they are
        // rejected in ingestBuild(at:) — but that is a subtlety this
        // destructive path must not silently depend on.
        var stem = archiveURL.deletingPathExtension().lastPathComponent
        if stem.isEmpty || stem == "." || stem == ".." {
            stem = "archive"
        }
        let destination = workspaceDirectory
            .appendingPathComponent("ingest", isDirectory: true)
            .appendingPathComponent(stem, isDirectory: true)
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.createDirectory(at: destination, withIntermediateDirectories: true)

        // bsdtar, not ditto: a dragged zip is a trust boundary, and bsdtar's
        // defaults enforce containment where ditto enforces nothing —
        // entries with ".." fail the extraction, leading "/" is stripped
        // (the entry lands inside the destination), and writing through a
        // symlink is refused (libarchive SECURE_NODOTDOT / SECURE_SYMLINKS).
        let extract = SubprocessCommand(
            executablePath: "/usr/bin/tar",
            arguments: ["-x", "-f", archiveURL.path, "-C", destination.path]
        )
        let result = try await environment.subprocess.run(extract)
        guard result.exitCode == 0 else {
            throw SubprocessFailure(
                command: extract,
                exitCode: result.exitCode,
                standardError: String(decoding: result.standardError, as: UTF8.self)
            )
        }

        guard let appBundleURL = Self.firstAppBundle(under: destination) else {
            throw BuildIngestError.noAppBundleInArchive(archiveName: archiveURL.lastPathComponent)
        }
        return try readBuild(fromAppBundle: appBundleURL)
    }

    /// Breadth-first, name-sorted search so the found bundle is deterministic
    /// regardless of filesystem enumeration order. Does not descend into
    /// .app bundles.
    private static func firstAppBundle(under root: URL) -> URL? {
        let fileManager = FileManager.default
        var queue = [root]
        while !queue.isEmpty {
            let directory = queue.removeFirst()
            let children = (try? fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles]
            )) ?? []
            for child in children.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                // Only real directories: a crafted archive can deliver
                // `Whatever.app` as a symlink pointing outside the extraction
                // root, which must never be ingested. (isDirectoryKey does not
                // follow symlinks, but keep the exclusion explicit — this is a
                // trust boundary.)
                let values = try? child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard values?.isDirectory == true, values?.isSymbolicLink != true else {
                    continue
                }
                if child.pathExtension == "app" {
                    return child
                }
                queue.append(child)
            }
        }
        return nil
    }

    /// Reads a Build's identity from `<bundle>/Info.plist`.
    func readBuild(fromAppBundle bundleURL: URL) throws -> Build {
        let bundleName = bundleURL.lastPathComponent
        let plistURL = bundleURL.appendingPathComponent("Info.plist")
        guard FileManager.default.fileExists(atPath: plistURL.path) else {
            throw BuildIngestError.missingInfoPlist(bundleName: bundleName)
        }
        let plistData = try Data(contentsOf: plistURL)
        guard
            let plist = try? PropertyListSerialization.propertyList(from: plistData, format: nil),
            let info = plist as? [String: Any]
        else {
            throw BuildIngestError.malformedInfoPlist(bundleName: bundleName)
        }

        let identityKeys = ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"]
        let values = identityKeys.map { info[$0] as? String }
        let missing = zip(identityKeys, values).filter { $1?.isEmpty ?? true }.map(\.0)
        guard missing.isEmpty else {
            throw BuildIngestError.missingIdentityKeys(bundleName: bundleName, keys: missing)
        }

        let platforms = info["CFBundleSupportedPlatforms"] as? [String] ?? []
        guard platforms.contains("iPhoneSimulator") else {
            throw BuildIngestError.notASimulatorBuild(bundleName: bundleName, platforms: platforms)
        }

        return Build(
            identity: BuildIdentity(
                bundleID: values[0]!,
                version: values[1]!,
                buildNumber: values[2]!
            ),
            appBundleURL: bundleURL
        )
    }
}
