import Foundation
import ImageIO
import UniformTypeIdentifiers

public enum DesignSnapshotMediaType: String, Codable, Sendable {
    case png
    case jpeg

    public var fileExtension: String {
        switch self {
        case .png: "png"
        case .jpeg: "jpg"
        }
    }

    var contentType: String {
        switch self {
        case .png: "image/png"
        case .jpeg: "image/jpeg"
        }
    }

    var uniformType: UTType {
        switch self {
        case .png: .png
        case .jpeg: .jpeg
        }
    }

    public init(fileExtension: String) throws {
        switch fileExtension.lowercased() {
        case "png": self = .png
        case "jpg", "jpeg": self = .jpeg
        case let fileExtension:
            throw DesignSnapshotError.unsupportedFileType(fileExtension: fileExtension)
        }
    }
}

public struct DesignSnapshot: Equatable, Sendable, Identifiable {
    public let id: UUID
    public internal(set) var name: String
    public internal(set) var mediaType: DesignSnapshotMediaType
    public internal(set) var data: Data

    init(id: UUID = UUID(), name: String, mediaType: DesignSnapshotMediaType, data: Data) {
        self.id = id
        self.name = name
        self.mediaType = mediaType
        self.data = data
    }
}

public enum DesignSnapshotError: Error, Equatable, LocalizedError {
    case findingNotEditable
    case snapshotNotFound
    case emptyName
    case unreadableImage
    case mediaTypeMismatch(expected: DesignSnapshotMediaType)
    case unsupportedFileType(fileExtension: String)

    public var errorDescription: String? {
        switch self {
        case .findingNotEditable:
            "Design Snapshots can only be changed on an editable Finding."
        case .snapshotNotFound:
            "This Design Snapshot is no longer attached to the Finding."
        case .emptyName:
            "Give the Design Snapshot a name."
        case .unreadableImage:
            "Choose a readable PNG or JPEG image."
        case .mediaTypeMismatch(let expected):
            "This image is not a valid \(expected == .png ? "PNG" : "JPEG") file."
        case .unsupportedFileType(let fileExtension):
            "\(fileExtension.isEmpty ? "This file" : ".\(fileExtension)") is not supported. Choose a PNG or JPEG image."
        }
    }
}

public struct DesignSnapshotFile: Sendable {
    public var name: String
    public var data: Data

    public init(name: String, data: Data) {
        self.name = name
        self.data = data
    }
}

public struct RejectedDesignSnapshot: Equatable, Sendable {
    public var name: String
    public var error: DesignSnapshotError

    public init(name: String, error: DesignSnapshotError) {
        self.name = name
        self.error = error
    }
}

public struct DesignSnapshotImportResult: Equatable, Sendable {
    public var added: [DesignSnapshot.ID]
    public var rejected: [RejectedDesignSnapshot]

    public init(added: [DesignSnapshot.ID], rejected: [RejectedDesignSnapshot]) {
        self.added = added
        self.rejected = rejected
    }
}

extension DesignSnapshot {
    static func validated(
        id: UUID = UUID(),
        name: String,
        mediaType: DesignSnapshotMediaType,
        data: Data
    ) throws -> DesignSnapshot {
        let normalizedName = try normalizedName(name, mediaType: mediaType)
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              CGImageSourceCreateImageAtIndex(source, 0, nil) != nil
        else {
            throw DesignSnapshotError.unreadableImage
        }
        guard let sourceType = CGImageSourceGetType(source) as String?,
              let detectedType = UTType(sourceType),
              detectedType.conforms(to: mediaType.uniformType)
        else {
            throw DesignSnapshotError.mediaTypeMismatch(expected: mediaType)
        }
        return DesignSnapshot(id: id, name: normalizedName, mediaType: mediaType, data: data)
    }

    static func normalizedName(
        _ name: String,
        mediaType: DesignSnapshotMediaType,
        preferredExtension: String? = nil
    ) throws -> String {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { throw DesignSnapshotError.emptyName }
        let path = trimmedName as NSString
        let suppliedExtension = path.pathExtension
        if (try? DesignSnapshotMediaType(fileExtension: suppliedExtension)) == mediaType {
            return trimmedName
        }
        let base = suppliedExtension.isEmpty ? trimmedName : path.deletingPathExtension
        let preferredMatches = preferredExtension.flatMap {
            (try? DesignSnapshotMediaType(fileExtension: $0)) == mediaType ? $0 : nil
        }
        return "\(base).\(preferredMatches ?? mediaType.fileExtension)"
    }
}

extension Collection where Element == DesignSnapshot {
    func effectiveAttachmentNames(reserving reservedNames: [String]) -> [String] {
        var used = Set(reservedNames.map { $0.lowercased() })
        return map { snapshot in
            let original = snapshot.name as NSString
            let fileExtension = original.pathExtension.isEmpty
                ? snapshot.mediaType.fileExtension
                : original.pathExtension
            let base = original.pathExtension.isEmpty
                ? snapshot.name
                : original.deletingPathExtension
            var candidate = "\(base).\(fileExtension)"
            var suffix = 2
            while used.contains(candidate.lowercased()) {
                candidate = "\(base) (\(suffix)).\(fileExtension)"
                suffix += 1
            }
            used.insert(candidate.lowercased())
            return candidate
        }
    }
}

extension ReviewSession {
    public mutating func addDesignSnapshotFiles(
        _ files: [DesignSnapshotFile],
        to findingID: TrayItem.ID
    ) throws -> DesignSnapshotImportResult {
        _ = try editableFindingIndex(findingID)
        var added: [DesignSnapshot.ID] = []
        var rejected: [RejectedDesignSnapshot] = []
        for file in files {
            do {
                let mediaType = try DesignSnapshotMediaType(
                    fileExtension: (file.name as NSString).pathExtension
                )
                added.append(try addDesignSnapshot(
                    to: findingID,
                    name: file.name,
                    mediaType: mediaType,
                    data: file.data
                ))
            } catch let error as DesignSnapshotError {
                rejected.append(RejectedDesignSnapshot(name: file.name, error: error))
            }
        }
        return DesignSnapshotImportResult(added: added, rejected: rejected)
    }

    @discardableResult
    public mutating func addDesignSnapshot(
        to findingID: TrayItem.ID,
        name: String,
        mediaType: DesignSnapshotMediaType,
        data: Data
    ) throws -> DesignSnapshot.ID {
        let index = try editableFindingIndex(findingID)
        let snapshot = try DesignSnapshot.validated(name: name, mediaType: mediaType, data: data)
        tray[index].finding.designSnapshots.append(snapshot)
        return snapshot.id
    }

    public mutating func renameDesignSnapshot(
        _ snapshotID: DesignSnapshot.ID,
        in findingID: TrayItem.ID,
        to name: String
    ) throws {
        let location = try designSnapshotLocation(snapshotID, in: findingID)
        let snapshot = tray[location.finding].finding.designSnapshots[location.snapshot]
        tray[location.finding].finding.designSnapshots[location.snapshot].name = try DesignSnapshot.normalizedName(
            name,
            mediaType: snapshot.mediaType,
            preferredExtension: (snapshot.name as NSString).pathExtension
        )
    }

    public mutating func replaceDesignSnapshot(
        _ snapshotID: DesignSnapshot.ID,
        in findingID: TrayItem.ID,
        mediaType: DesignSnapshotMediaType,
        data: Data
    ) throws {
        let location = try designSnapshotLocation(snapshotID, in: findingID)
        let current = tray[location.finding].finding.designSnapshots[location.snapshot]
        tray[location.finding].finding.designSnapshots[location.snapshot] = try DesignSnapshot.validated(
            id: current.id,
            name: current.name,
            mediaType: mediaType,
            data: data
        )
    }

    public mutating func removeDesignSnapshot(
        _ snapshotID: DesignSnapshot.ID,
        from findingID: TrayItem.ID
    ) throws {
        let location = try designSnapshotLocation(snapshotID, in: findingID)
        tray[location.finding].finding.designSnapshots.remove(at: location.snapshot)
    }

    private func editableFindingIndex(_ findingID: TrayItem.ID) throws -> Int {
        guard let index = tray.firstIndex(where: { $0.id == findingID }), tray[index].isEditable else {
            throw DesignSnapshotError.findingNotEditable
        }
        return index
    }

    private func designSnapshotLocation(
        _ snapshotID: DesignSnapshot.ID,
        in findingID: TrayItem.ID
    ) throws -> (finding: Int, snapshot: Int) {
        let finding = try editableFindingIndex(findingID)
        guard let snapshot = tray[finding].finding.designSnapshots.firstIndex(where: { $0.id == snapshotID }) else {
            throw DesignSnapshotError.snapshotNotFound
        }
        return (finding, snapshot)
    }
}
