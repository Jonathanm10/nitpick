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
    static func annotateWithAllFourTools(_ finding: inout Finding) {
        finding.add(Annotation(.pen(points: [
            CGPoint(x: 60, y: 120), CGPoint(x: 90, y: 180),
            CGPoint(x: 140, y: 150), CGPoint(x: 200, y: 260),
        ])))
        finding.add(Annotation(.arrow(from: CGPoint(x: 240, y: 400), to: CGPoint(x: 120, y: 300)), color: .blue))
        finding.add(Annotation(.rectangle(CGRect(x: 60, y: 500, width: 240, height: 160)), color: .green))
        finding.add(Annotation(.label("2pt off", at: CGPoint(x: 100, y: 700)), color: .black))
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
}
