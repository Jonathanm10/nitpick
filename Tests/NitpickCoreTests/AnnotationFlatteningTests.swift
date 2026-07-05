import CoreGraphics
import Foundation
import NitpickCore
import Testing

/// Flattening Annotations into the attached image: native resolution
/// preserved, unannotated Findings pass the original bytes through, and the
/// rendered output of all four tools is pinned by a tolerance-based
/// snapshot (PRD testing decisions).
@Suite("Annotation flattening")
struct AnnotationFlatteningTests {
    static func finding(screenshotPNG: Data) -> Finding {
        Finding(
            summary: "Button color is off",
            description: "",
            screenshotPNG: screenshotPNG,
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )
    }

    /// One of each tool, three palette colors beyond the default — the
    /// scene the snapshot pins.
    static let fourTools = [
        Annotation(.pen(points: [
            CGPoint(x: 60, y: 120), CGPoint(x: 90, y: 180),
            CGPoint(x: 140, y: 150), CGPoint(x: 200, y: 260)
        ])),
        Annotation(.arrow(from: CGPoint(x: 240, y: 400), to: CGPoint(x: 120, y: 300)), color: .blue),
        Annotation(.rectangle(CGRect(x: 60, y: 500, width: 240, height: 160)), color: .green),
        Annotation(.label("2pt off", at: CGPoint(x: 100, y: 700)), color: .black)
    ]

    static func annotateWithAllFourTools(_ finding: inout Finding) {
        for annotation in fourTools { finding.add(annotation) }
    }

    @Test("no Annotations: the annotated variant is the original, byte for byte")
    func passthrough() throws {
        let png = try ImageFixtures.solidPNG(width: 480, height: 960)
        let finding = Self.finding(screenshotPNG: png)
        #expect(try finding.annotatedScreenshotPNG() == png)
    }

    @Test("flattening keeps native resolution and actually marks pixels")
    func flattenedOutput() throws {
        var finding = Self.finding(screenshotPNG: try ImageFixtures.solidPNG(width: 480, height: 960))
        Self.annotateWithAllFourTools(&finding)

        let flattened = try finding.annotatedScreenshotPNG()
        #expect(flattened != finding.screenshotPNG)

        let decoded = try ImageFixtures.decodeRGBA(flattened)
        #expect(decoded.width == 480)
        #expect(decoded.height == 960)
    }

    @Test("all four tools flatten as pinned by the reference snapshot")
    func snapshot() throws {
        var finding = Self.finding(screenshotPNG: try ImageFixtures.solidPNG(width: 480, height: 960))
        Self.annotateWithAllFourTools(&finding)
        try ImageFixtures.expectMatchesSnapshot(
            try finding.annotatedScreenshotPNG(),
            named: "flattened-four-tools"
        )
    }

    @Test("an unreadable screenshot is a thrown error, not a crash")
    func unreadableScreenshot() throws {
        var finding = Self.finding(screenshotPNG: Data([0x89, 0x50, 0x4E, 0x47]))
        finding.add(Annotation(.rectangle(CGRect(x: 0, y: 0, width: 10, height: 10))))
        #expect(throws: AnnotationRenderingError.unreadableScreenshot) {
            try finding.annotatedScreenshotPNG()
        }
    }

    @Test("stroke width and font size scale with the capture's resolution")
    func metricsScale() {
        let phone = AnnotationMetrics(imageSize: CGSize(width: 1179, height: 2556))
        let small = AnnotationMetrics(imageSize: CGSize(width: 480, height: 960))
        #expect(phone.strokeWidth > small.strokeWidth)
        #expect(phone.fontSize > small.fontSize)
        // Tiny images still get visible marks.
        let tiny = AnnotationMetrics(imageSize: CGSize(width: 32, height: 32))
        #expect(tiny.strokeWidth >= 3)
        #expect(tiny.fontSize >= 13)
    }

    @Test("excluding one index: that shape is absent, the rest pixel-identical")
    func excludeOneIndex() throws {
        let png = try ImageFixtures.solidPNG(width: 480, height: 960)
        var finding = Self.finding(screenshotPNG: png)
        Self.annotateWithAllFourTools(&finding)

        let excluded = try finding.annotatedScreenshotImage(excludingAnnotationAt: 1)

        // Reference: the same scene never given the arrow at index 1 —
        // an independent render path, not the exclusion re-applied.
        var reference = Self.finding(screenshotPNG: png)
        Self.annotateWithAllFourTools(&reference)
        reference.removeAnnotation(at: 1)
        #expect(try ImageFixtures.rgba(excluded) == ImageFixtures.rgba(reference.annotatedScreenshotImage()))

        // And the arrow was really in the full render.
        #expect(try ImageFixtures.rgba(excluded) != ImageFixtures.rgba(finding.annotatedScreenshotImage()))
    }

    @Test("an out-of-range or absent exclusion renders everything")
    func excludeOutOfRange() throws {
        var finding = Self.finding(screenshotPNG: try ImageFixtures.solidPNG(width: 480, height: 960))
        Self.annotateWithAllFourTools(&finding)
        let full = try ImageFixtures.rgba(finding.annotatedScreenshotImage())
        #expect(try ImageFixtures.rgba(finding.annotatedScreenshotImage(excludingAnnotationAt: 99)) == full)
        #expect(try ImageFixtures.rgba(finding.annotatedScreenshotImage(excludingAnnotationAt: -1)) == full)
        #expect(try ImageFixtures.rgba(finding.annotatedScreenshotImage(excludingAnnotationAt: nil)) == full)
    }

    @Test("a shape rendered alone over the exclude-render composites to the full render")
    func overlayComposite() throws {
        let size = CGSize(width: 480, height: 960)
        var finding = Self.finding(screenshotPNG: try ImageFixtures.solidPNG(width: 480, height: 960))
        Self.annotateWithAllFourTools(&finding)
        let topIndex = finding.annotations.count - 1

        let overlay = try #require(finding.annotations[topIndex].renderedAlone(canvasSize: size))
        let overlayPixels = try ImageFixtures.rgba(overlay)
        // The overlay sits on transparency — corner pixel alpha is zero.
        #expect(overlayPixels.pixels[3] == 0)

        // Exclude-render plus the overlay, composited exactly as the shell
        // stacks them, matches the full render within compositing rounding.
        let base = try finding.annotatedScreenshotImage(excludingAnnotationAt: topIndex)
        let context = try #require(CGContext(
            data: nil, width: 480, height: 960, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(base, in: CGRect(origin: .zero, size: size))
        context.draw(overlay, in: CGRect(origin: .zero, size: size))
        let composited = try ImageFixtures.rgba(#require(context.makeImage()))

        let expected = try ImageFixtures.rgba(finding.annotatedScreenshotImage())
        var maxDelta = 0
        for index in composited.pixels.indices {
            maxDelta = max(maxDelta, abs(Int(composited.pixels[index]) - Int(expected.pixels[index])))
        }
        #expect(maxDelta <= 2)
    }

    /// The shell previews a drag by shifting the once-rendered overlay by
    /// whole pixels — honest only if rendering is translation-invariant on
    /// the pixel lattice, byte for byte, for every shape kind.
    @Test("rendering alone shifts exactly with a whole-pixel translation", arguments: fourTools)
    func overlayShiftInvariance(annotation: Annotation) throws {
        let size = CGSize(width: 480, height: 960)
        let deltaX = 7
        let deltaY = -5
        let original = try ImageFixtures.rgba(#require(annotation.renderedAlone(canvasSize: size)))
        let shifted = try ImageFixtures.rgba(#require(
            annotation.translated(by: CGVector(dx: deltaX, dy: deltaY)).renderedAlone(canvasSize: size)
        ))

        var mismatched = 0
        for row in 0..<960 {
            let sourceRow = row - deltaY
            guard (0..<960).contains(sourceRow) else { continue }
            for column in 0..<480 {
                let sourceColumn = column - deltaX
                guard (0..<480).contains(sourceColumn) else { continue }
                for channel in 0..<4
                where shifted.pixels[(row * 480 + column) * 4 + channel]
                    != original.pixels[(sourceRow * 480 + sourceColumn) * 4 + channel] {
                    mismatched += 1
                }
            }
        }
        #expect(mismatched == 0)
    }
}
