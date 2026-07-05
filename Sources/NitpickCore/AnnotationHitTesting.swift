import CoreGraphics
import CoreText
import Foundation

extension AnnotationMetrics {
    /// How far (in image pixels) a click may land from a mark's path and
    /// still hit it. Scaled to the stroke width so thin marks are not
    /// precision targets at any capture resolution.
    public var hitTolerance: CGFloat { strokeWidth * 2 }

    /// The label typeface, shared by the renderer and hit-testing so the
    /// hit target is exactly the drawn text.
    var labelFont: CTFont {
        CTFontCreateWithName("Helvetica-Bold" as CFString, fontSize, nil)
    }
}

extension Finding {
    /// The index of the topmost Annotation under `point` (image pixels),
    /// or nil when the point hits nothing. Overlaps resolve topmost-first
    /// in stacking order, so a click on stacked marks selects what the
    /// designer sees on top.
    public func annotationIndex(at point: CGPoint, metrics: AnnotationMetrics) -> Int? {
        annotations.lastIndex { $0.hitTest(point, metrics: metrics) }
    }
}

extension Annotation {
    /// Whether `point` (image pixels) hits this Annotation as rendered
    /// with `metrics`. Rectangles hit on their stroke only — a frame
    /// never shields the marks it encloses; pen strokes and arrows hit
    /// within `hitTolerance` of their path; labels hit on their rendered
    /// text bounds.
    public func hitTest(_ point: CGPoint, metrics: AnnotationMetrics) -> Bool {
        switch shape {
        case .pen(let points):
            guard let first = points.first else { return false }
            // A single point renders as a dot; a degenerate segment
            // measures distance to that point.
            if points.count == 1 {
                return distance(from: point, toSegment: first, first) <= metrics.hitTolerance
            }
            return zip(points, points.dropFirst()).contains {
                distance(from: point, toSegment: $0, $1) <= metrics.hitTolerance
            }

        case .arrow(let from, let to):
            // The head fans arrowHeadWidth/2 (1.5× strokeWidth) around the
            // shaft's line — inside the tolerance, so one segment covers
            // shaft and head alike.
            return distance(from: point, toSegment: from, to) <= metrics.hitTolerance

        case .rectangle(let rect):
            let edges = rect.standardized
            let corners = [
                CGPoint(x: edges.minX, y: edges.minY), CGPoint(x: edges.maxX, y: edges.minY),
                CGPoint(x: edges.maxX, y: edges.maxY), CGPoint(x: edges.minX, y: edges.maxY)
            ]
            return (0..<4).contains {
                distance(from: point, toSegment: corners[$0], corners[($0 + 1) % 4])
                    <= metrics.hitTolerance
            }

        case .label:
            guard let bounds = boundingRect(metrics: metrics) else { return false }
            return bounds.contains(point)
        }
    }

    /// The rendered bounds in image pixels — what the shell's selection
    /// indicator outlines. A label measures with the same CoreText line
    /// the renderer draws, so the outline hugs the visible text. Nil for
    /// a shape that renders nothing (an empty pen stroke, an empty label).
    public func boundingRect(metrics: AnnotationMetrics) -> CGRect? {
        switch shape {
        case .pen(let points):
            guard let first = points.first else { return nil }
            var rect = CGRect(origin: first, size: .zero)
            for point in points.dropFirst() {
                rect = rect.union(CGRect(origin: point, size: .zero))
            }
            return rect.insetBy(dx: -metrics.strokeWidth / 2, dy: -metrics.strokeWidth / 2)

        case .arrow(let from, let to):
            let rect = CGRect(origin: from, size: .zero)
                .union(CGRect(origin: to, size: .zero))
            let pad = max(metrics.strokeWidth, metrics.arrowHeadWidth) / 2
            return rect.insetBy(dx: -pad, dy: -pad)

        case .rectangle(let rect):
            return rect.standardized
                .insetBy(dx: -metrics.strokeWidth / 2, dy: -metrics.strokeWidth / 2)

        case .label(let text, let position):
            guard !text.isEmpty else { return nil }
            let attributed = NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): metrics.labelFont
            ])
            let line = CTLineCreateWithAttributedString(attributed)
            var ascent: CGFloat = 0
            var descent: CGFloat = 0
            let width = CTLineGetTypographicBounds(line, &ascent, &descent, nil)
            return CGRect(x: position.x, y: position.y, width: width, height: ascent + descent)
        }
    }
}

/// Distance from `point` to the segment `start`–`end`; to the nearer
/// endpoint when the perpendicular foot falls outside the segment.
private func distance(from point: CGPoint, toSegment start: CGPoint, _ end: CGPoint) -> CGFloat {
    let deltaX = end.x - start.x
    let deltaY = end.y - start.y
    let lengthSquared = deltaX * deltaX + deltaY * deltaY
    guard lengthSquared > 0 else { return hypot(point.x - start.x, point.y - start.y) }
    let along = ((point.x - start.x) * deltaX + (point.y - start.y) * deltaY) / lengthSquared
    let clamped = max(0, min(1, along))
    return hypot(point.x - (start.x + clamped * deltaX), point.y - (start.y + clamped * deltaY))
}
