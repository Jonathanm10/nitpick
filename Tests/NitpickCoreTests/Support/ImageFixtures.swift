import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

/// Deterministic image fixtures and the tolerance-based snapshot check for
/// Annotation flattening (PRD testing decisions: tolerance, never
/// pixel-exact — text antialiasing may drift across macOS releases).
enum ImageFixtures {
    /// A solid sRGB PNG — a deterministic stand-in for a capture.
    static func solidPNG(width: Int, height: Int, white: CGFloat = 0.93) throws -> Data {
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(srgbRed: white, green: white, blue: white, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try #require(context.makeImage())
        return try encodePNG(image)
    }

    static func encodePNG(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            data, UTType.png.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        try #require(CGImageDestinationFinalize(destination))
        return data as Data
    }

    static func solidJPEG(width: Int, height: Int) throws -> Data {
        let png = try solidPNG(width: width, height: height)
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        try #require(CGImageDestinationFinalize(destination))
        return data as Data
    }

    /// Decodes a PNG into a normalized RGBA8 sRGB pixel buffer, so two
    /// images compare by color values regardless of how they were encoded.
    static func decodeRGBA(_ png: Data) throws -> (width: Int, height: Int, pixels: [UInt8]) {
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        return try rgba(#require(CGImageSourceCreateImageAtIndex(source, 0, nil)))
    }

    /// Normalizes a CGImage into the same RGBA8 sRGB pixel buffer, for
    /// comparing renders that never round-trip through PNG.
    static func rgba(_ image: CGImage) throws -> (width: Int, height: Int, pixels: [UInt8]) {
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        try pixels.withUnsafeMutableBytes { buffer in
            let context = try #require(CGContext(
                data: buffer.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return (width, height, pixels)
    }

    /// Compares a rendered PNG against a committed reference within
    /// tolerance: dimensions must match exactly; a pixel matches when every
    /// channel is within `maxChannelDelta`; up to `maxMismatchedFraction`
    /// of pixels may disagree. The channel delta absorbs antialiasing
    /// drift; the fraction is deliberately smaller than the smallest
    /// single mark (the label, ≈0.09% of the reference), so losing any one
    /// Annotation fails. Set NITPICK_RECORD_SNAPSHOTS=1 to (re)record.
    static func expectMatchesSnapshot(
        _ png: Data,
        named name: String,
        maxChannelDelta: Int = 32,
        maxMismatchedFraction: Double = 0.0005,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let reference = snapshotsDirectory.appendingPathComponent("\(name).png")

        if ProcessInfo.processInfo.environment["NITPICK_RECORD_SNAPSHOTS"] == "1" {
            try FileManager.default.createDirectory(
                at: snapshotsDirectory, withIntermediateDirectories: true
            )
            try png.write(to: reference)
            Issue.record(
                "Recorded \(reference.path); rerun without NITPICK_RECORD_SNAPSHOTS.",
                sourceLocation: sourceLocation
            )
            return
        }

        guard FileManager.default.fileExists(atPath: reference.path) else {
            let candidate = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(name)-\(UUID().uuidString).png")
            try png.write(to: candidate)
            Issue.record(
                "No reference snapshot at \(reference.path). Candidate written to \(candidate.path); record with NITPICK_RECORD_SNAPSHOTS=1.",
                sourceLocation: sourceLocation
            )
            return
        }

        let expected = try decodeRGBA(Data(contentsOf: reference))
        let actual = try decodeRGBA(png)
        guard expected.width == actual.width, expected.height == actual.height else {
            Issue.record(
                "Snapshot \(name): size \(actual.width)×\(actual.height) ≠ reference \(expected.width)×\(expected.height).",
                sourceLocation: sourceLocation
            )
            return
        }

        var mismatched = 0
        for pixel in stride(from: 0, to: actual.pixels.count, by: 4) {
            for channel in 0..<4 {
                let delta = abs(Int(actual.pixels[pixel + channel]) - Int(expected.pixels[pixel + channel]))
                if delta > maxChannelDelta {
                    mismatched += 1
                    break
                }
            }
        }
        let fraction = Double(mismatched) / Double(actual.width * actual.height)
        if fraction > maxMismatchedFraction {
            let candidate = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(name)-\(UUID().uuidString).png")
            try png.write(to: candidate)
            let percent = (fraction * 100).formatted(.number.precision(.fractionLength(1)))
            let message = "Snapshot \(name): \(mismatched) of \(actual.width * actual.height) pixels "
                + "(\(percent)%) beyond ±\(maxChannelDelta). Candidate written to \(candidate.path)."
            Issue.record(Comment(rawValue: message), sourceLocation: sourceLocation)
        }
    }

    /// The committed snapshot directory, located from this source file so
    /// tests never depend on the working directory.
    private static var snapshotsDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // Support/
            .deletingLastPathComponent()  // NitpickCoreTests/
            .appendingPathComponent("Snapshots", isDirectory: true)
    }
}
