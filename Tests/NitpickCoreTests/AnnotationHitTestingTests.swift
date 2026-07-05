import Foundation
import NitpickCore
import Testing

/// Hit-testing committed Annotations through the core's public API: an
/// image-pixel point maps to the index of the topmost Annotation it hits,
/// using the same geometry the renderer draws with. Rectangles hit on
/// their stroke only — a frame never shields the marks it encloses; pen
/// strokes and arrows hit within a tolerance of their path; labels hit on
/// their rendered text bounds.
@Suite("Annotation hit-testing")
struct AnnotationHitTestingTests {
    /// A 1000×2000 capture: strokeWidth 12, so hit geometry is roomy
    /// enough to probe on either side of the tolerance line.
    static let metrics = AnnotationMetrics(imageSize: CGSize(width: 1000, height: 2000))

    static func finding(_ annotations: [Annotation]) -> Finding {
        var finding = Finding(
            summary: "Button color is off",
            description: "",
            screenshotPNG: Data([0x89, 0x50, 0x4E, 0x47]),
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )
        for annotation in annotations { finding.add(annotation) }
        return finding
    }

    @Test("a pen stroke hits within tolerance of its path and misses outside it")
    func penTolerance() {
        let pen = Annotation(.pen(points: [CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 100)]))
        let finding = Self.finding([pen])
        let tolerance = Self.metrics.hitTolerance
        #expect(finding.annotationIndex(at: CGPoint(x: 200, y: 100), metrics: Self.metrics) == 0)
        #expect(finding.annotationIndex(at: CGPoint(x: 200, y: 100 + tolerance), metrics: Self.metrics) == 0)
        #expect(finding.annotationIndex(at: CGPoint(x: 200, y: 100 + tolerance + 1), metrics: Self.metrics) == nil)
    }

    @Test("a single-point pen dot is a hit target, not a precision trap")
    func penDot() {
        let dot = Annotation(.pen(points: [CGPoint(x: 400, y: 400)]))
        let finding = Self.finding([dot])
        let tolerance = Self.metrics.hitTolerance
        #expect(finding.annotationIndex(at: CGPoint(x: 400, y: 400), metrics: Self.metrics) == 0)
        #expect(finding.annotationIndex(at: CGPoint(x: 400 + tolerance, y: 400), metrics: Self.metrics) == 0)
        #expect(finding.annotationIndex(at: CGPoint(x: 400 + tolerance + 1, y: 400), metrics: Self.metrics) == nil)
    }

    @Test("an arrow hits along its shaft and at its head, misses beyond tolerance")
    func arrowTolerance() {
        let arrow = Annotation(.arrow(from: CGPoint(x: 100, y: 500), to: CGPoint(x: 500, y: 500)))
        let finding = Self.finding([arrow])
        let tolerance = Self.metrics.hitTolerance
        #expect(finding.annotationIndex(at: CGPoint(x: 300, y: 500), metrics: Self.metrics) == 0)  // shaft
        #expect(finding.annotationIndex(at: CGPoint(x: 500, y: 500), metrics: Self.metrics) == 0)  // head tip
        #expect(finding.annotationIndex(at: CGPoint(x: 300, y: 500 + tolerance + 1), metrics: Self.metrics) == nil)
        #expect(finding.annotationIndex(at: CGPoint(x: 500 + tolerance + 1, y: 500), metrics: Self.metrics) == nil)
    }

    @Test("a rectangle hits on its stroke, never its interior")
    func rectangleStrokeOnly() {
        let rectangle = Annotation(.rectangle(CGRect(x: 200, y: 200, width: 400, height: 300)))
        let finding = Self.finding([rectangle])
        let tolerance = Self.metrics.hitTolerance
        #expect(finding.annotationIndex(at: CGPoint(x: 200, y: 350), metrics: Self.metrics) == 0)  // left edge
        #expect(finding.annotationIndex(at: CGPoint(x: 200, y: 200), metrics: Self.metrics) == 0)  // corner
        let nearStroke = CGPoint(x: 200 + tolerance, y: 350)
        #expect(finding.annotationIndex(at: nearStroke, metrics: Self.metrics) == 0)  // inside, near the stroke
        #expect(finding.annotationIndex(at: CGPoint(x: 400, y: 350), metrics: Self.metrics) == nil)  // interior center
        let outside = CGPoint(x: 200 - tolerance - 1, y: 350)
        #expect(finding.annotationIndex(at: outside, metrics: Self.metrics) == nil)
    }

    @Test("a label hits on its rendered text bounds")
    func labelBounds() throws {
        let label = Annotation(.label("2pt off", at: CGPoint(x: 600, y: 1000)), color: .black)
        let finding = Self.finding([label])
        let bounds = try #require(label.boundingRect(metrics: Self.metrics))
        #expect(bounds.minX == 600)  // the anchor is the rendered line's top-left
        #expect(bounds.minY == 1000)
        #expect(bounds.width > Self.metrics.fontSize)  // several glyphs wide
        #expect(bounds.height >= Self.metrics.fontSize / 2)
        #expect(finding.annotationIndex(at: CGPoint(x: bounds.midX, y: bounds.midY), metrics: Self.metrics) == 0)
        #expect(finding.annotationIndex(at: CGPoint(x: bounds.maxX + 1, y: bounds.midY), metrics: Self.metrics) == nil)
        #expect(finding.annotationIndex(at: CGPoint(x: bounds.midX, y: bounds.minY - 1), metrics: Self.metrics) == nil)
    }

    @Test("an empty label renders nothing and hits nothing")
    func emptyLabel() {
        let label = Annotation(.label("", at: CGPoint(x: 600, y: 1000)))
        let finding = Self.finding([label])
        #expect(finding.annotationIndex(at: CGPoint(x: 600, y: 1000), metrics: Self.metrics) == nil)
    }

    @Test("a frame never shields a label inside it — interior misses, label hits")
    func frameAndLabel() throws {
        let frame = Annotation(.rectangle(CGRect(x: 100, y: 800, width: 800, height: 600)), color: .green)
        let label = Annotation(.label("Misaligned", at: CGPoint(x: 400, y: 1050)), color: .black)
        let finding = Self.finding([frame, label])
        let labelBounds = try #require(label.boundingRect(metrics: Self.metrics))
        let onLabel = CGPoint(x: labelBounds.midX, y: labelBounds.midY)
        #expect(finding.annotationIndex(at: onLabel, metrics: Self.metrics) == 1)
        #expect(finding.annotationIndex(at: CGPoint(x: 100, y: 1100), metrics: Self.metrics) == 0)  // frame stroke
        #expect(finding.annotationIndex(at: CGPoint(x: 250, y: 900), metrics: Self.metrics) == nil)  // empty interior
    }

    @Test("overlapping shapes resolve topmost-first in stacking order")
    func topmostFirst() {
        let below = Annotation(.pen(points: [CGPoint(x: 100, y: 1500), CGPoint(x: 500, y: 1500)]))
        let above = Annotation(.pen(points: [CGPoint(x: 300, y: 1300), CGPoint(x: 300, y: 1700)]), color: .blue)
        let finding = Self.finding([below, above])
        // The crossing point hits both; the later — topmost — wins.
        #expect(finding.annotationIndex(at: CGPoint(x: 300, y: 1500), metrics: Self.metrics) == 1)
        // Off the crossing, each is reachable on its own.
        #expect(finding.annotationIndex(at: CGPoint(x: 150, y: 1500), metrics: Self.metrics) == 0)
        #expect(finding.annotationIndex(at: CGPoint(x: 300, y: 1350), metrics: Self.metrics) == 1)
    }

    @Test("a Finding with no Annotations hits nothing")
    func emptyFinding() {
        #expect(Self.finding([]).annotationIndex(at: CGPoint(x: 500, y: 500), metrics: Self.metrics) == nil)
    }

    @Test("bounding rects cover the rendered mark, for the shell's selection indicator")
    func boundingRects() throws {
        let pen = Annotation(.pen(points: [CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 160)]))
        let penBounds = try #require(pen.boundingRect(metrics: Self.metrics))
        #expect(penBounds.contains(CGPoint(x: 100, y: 100)))
        #expect(penBounds.contains(CGPoint(x: 300, y: 160)))

        let arrow = Annotation(.arrow(from: CGPoint(x: 100, y: 500), to: CGPoint(x: 500, y: 500)))
        let arrowBounds = try #require(arrow.boundingRect(metrics: Self.metrics))
        // The head fans arrowHeadWidth wide around the shaft — the indicator must cover it.
        #expect(arrowBounds.contains(CGPoint(x: 500, y: 500 + Self.metrics.arrowHeadWidth / 2 - 1)))

        #expect(Annotation(.pen(points: [])).boundingRect(metrics: Self.metrics) == nil)
    }
}
