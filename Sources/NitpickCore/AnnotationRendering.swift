import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Sizing for rendered Annotations, derived from the capture's native pixel
/// size so marks stay visible at any device resolution. The shell's live
/// preview uses the same metrics (scaled to the view) — what the designer
/// draws is what the developer downloads.
public struct AnnotationMetrics: Equatable, Sendable {
    public var strokeWidth: CGFloat
    public var fontSize: CGFloat

    public var arrowHeadLength: CGFloat { strokeWidth * 4 }
    public var arrowHeadWidth: CGFloat { strokeWidth * 3 }

    public init(imageSize: CGSize) {
        let maxDimension = max(imageSize.width, imageSize.height)
        strokeWidth = max(3, (maxDimension * 0.006).rounded())
        fontSize = max(13, (maxDimension * 0.018).rounded())
    }
}

public enum AnnotationRenderingError: Error, LocalizedError, Equatable {
    /// The Finding's screenshot bytes don't decode as an image.
    case unreadableScreenshot

    public var errorDescription: String? {
        switch self {
        case .unreadableScreenshot:
            "The capture could not be read as an image, so Annotations cannot be flattened."
        }
    }
}

extension Finding {
    /// The annotated screenshot: the clean capture with every Annotation
    /// flattened in, at native resolution. With no Annotations the
    /// annotated variant *is* the original — the exact bytes pass through.
    public func annotatedScreenshotPNG() throws -> Data {
        guard !annotations.isEmpty else { return screenshotPNG }
        let image = try annotatedScreenshotImage()
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data, UTType.png.identifier as CFString, 1, nil
            )
        else { throw AnnotationRenderingError.unreadableScreenshot }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw AnnotationRenderingError.unreadableScreenshot
        }
        return data as Data
    }

    /// The flattened image, for the shell to display while editing. With
    /// `excludedIndex`, that one Annotation is left out — the base image
    /// under a mid-drag move, so the moving shape is never double-drawn
    /// or ghosted at its old position. An out-of-range or nil index
    /// excludes nothing.
    public func annotatedScreenshotImage(
        excludingAnnotationAt excludedIndex: Int? = nil
    ) throws -> CGImage {
        guard
            let source = CGImageSourceCreateWithData(screenshotPNG as CFData, nil),
            let base = CGImageSourceCreateImageAtIndex(source, 0, nil),
            let context = CGContext(
                data: nil, width: base.width, height: base.height,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: base.colorSpace.flatMap { $0.model == .rgb ? $0 : nil }
                    ?? CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { throw AnnotationRenderingError.unreadableScreenshot }

        let size = CGSize(width: base.width, height: base.height)
        context.draw(base, in: CGRect(origin: .zero, size: size))

        // Annotation coordinates are top-left origin; CoreGraphics is
        // bottom-left. Flip once, draw everything in annotation space.
        context.translateBy(x: 0, y: size.height)
        context.scaleBy(x: 1, y: -1)

        let metrics = AnnotationMetrics(imageSize: size)
        for (index, annotation) in annotations.enumerated() where index != excludedIndex {
            annotation.draw(in: context, metrics: metrics)
        }

        guard let image = context.makeImage() else {
            throw AnnotationRenderingError.unreadableScreenshot
        }
        return image
    }
}

extension Annotation {
    /// This Annotation rendered alone on a transparent canvas of the
    /// capture's pixel size, with the same metrics flattening uses — the
    /// shell's mid-drag overlay. It goes through the exact draw path
    /// flattening does, so the moving shape is pixel-identical to its
    /// committed self, and shifting it by whole pixels keeps it so —
    /// which is why drag offsets round to the pixel lattice. Stacked
    /// above the exclude-one base it visually lifts the shape over
    /// anything it overlaps for the drag's duration; release restores
    /// true stacking. Nil only for a degenerate canvas size.
    public func renderedAlone(canvasSize: CGSize) -> CGImage? {
        let width = Int(canvasSize.width)
        let height = Int(canvasSize.height)
        guard
            width > 0, height > 0,
            let context = CGContext(
                data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )
        else { return nil }
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)
        draw(in: context, metrics: AnnotationMetrics(imageSize: canvasSize))
        return context.makeImage()
    }
}

extension Annotation {
    /// Draws this Annotation into a context already flipped to top-left
    /// origin, in image pixel coordinates.
    func draw(in context: CGContext, metrics: AnnotationMetrics) {
        let cgColor = CGColor(
            srgbRed: color.components.red,
            green: color.components.green,
            blue: color.components.blue,
            alpha: 1
        )
        context.setStrokeColor(cgColor)
        context.setFillColor(cgColor)
        context.setLineWidth(metrics.strokeWidth)
        context.setLineCap(.round)
        context.setLineJoin(.round)

        switch shape {
        case .pen(let points):
            guard let first = points.first else { return }
            // A single point still leaves a visible dot: the round cap of a
            // zero-length stroke.
            context.beginPath()
            context.move(to: first)
            for point in points.dropFirst() { context.addLine(to: point) }
            if points.count == 1 { context.addLine(to: first) }
            context.strokePath()

        case .arrow(let from, let to):
            let length = hypot(to.x - from.x, to.y - from.y)
            guard length > 0 else { return }
            let direction = CGPoint(x: (to.x - from.x) / length, y: (to.y - from.y) / length)
            // The shaft stops where the head begins, so the tip stays sharp.
            let headBase = CGPoint(
                x: to.x - direction.x * metrics.arrowHeadLength,
                y: to.y - direction.y * metrics.arrowHeadLength
            )
            context.beginPath()
            context.move(to: from)
            context.addLine(to: headBase)
            context.strokePath()

            let normal = CGPoint(x: -direction.y, y: direction.x)
            context.beginPath()
            context.move(to: to)
            context.addLine(to: CGPoint(
                x: headBase.x + normal.x * metrics.arrowHeadWidth / 2,
                y: headBase.y + normal.y * metrics.arrowHeadWidth / 2
            ))
            context.addLine(to: CGPoint(
                x: headBase.x - normal.x * metrics.arrowHeadWidth / 2,
                y: headBase.y - normal.y * metrics.arrowHeadWidth / 2
            ))
            context.closePath()
            context.fillPath()

        case .rectangle(let rect):
            context.stroke(rect.standardized, width: metrics.strokeWidth)

        case .label(let text, let position):
            guard !text.isEmpty else { return }
            let font = metrics.labelFont
            let attributed = NSAttributedString(string: text, attributes: [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): cgColor,
            ])
            let line = CTLineCreateWithAttributedString(attributed)
            let ascent = CTFontGetAscent(font)
            // Core Text draws y-up; un-flip locally around the baseline,
            // which sits one ascent below the label's top-left anchor.
            context.saveGState()
            context.translateBy(x: position.x, y: position.y + ascent)
            context.scaleBy(x: 1, y: -1)
            context.textPosition = .zero
            CTLineDraw(line, context)
            context.restoreGState()
        }
    }
}
