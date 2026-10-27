import AppKit
import Foundation
import NitpickCore
import Observation

/// Annotations over one standalone image, the Feedback's window image,
/// behind the same surface and toolbar the Editor uses. Unlike the Editor's
/// Finding nothing here is persisted or filed mid-edit, so none of
/// `AppModel`'s session guards apply.
@MainActor
@Observable
final class AnnotatedImageModel: AnnotationEditing {
    /// The clean image; `annotations` are flattened into it only at send.
    let png: Data
    @ObservationIgnored private let decoded: DecodedScreenshot
    private(set) var history = AnnotationHistory()
    private(set) var capturedImage: NSImage?
    let capturePixelSize: CGSize?
    let captureID = UUID()
    var annotationTool: AnnotationTool = .pen {
        didSet {
            cancelAnnotationDrag()
            if annotationTool != .select { selectedIndex = nil }
        }
    }
    var annotationColor: AnnotationColor = .default
    var hasPendingLabelDraft = false
    private var selectedIndex: Int?
    private(set) var annotationDrag: AnnotationDrag<NSImage>?
    /// The sheet freezes its whole form while sending.
    var isBusy: Bool { false }

    /// Nil when `png` does not decode.
    init?(png: Data) {
        guard let decoded = try? DecodedScreenshot(png: png),
              let image = try? decoded.annotated(with: [])
        else { return nil }
        self.png = png
        self.decoded = decoded
        capturePixelSize = CGSize(width: image.width, height: image.height)
        capturedImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }

    var annotations: [Annotation] { history.annotations }

    var annotationMetrics: AnnotationMetrics? {
        capturePixelSize.map(AnnotationMetrics.init(imageSize:))
    }

    var canUndoAnnotation: Bool { history.canUndo }
    var canRedoAnnotation: Bool { history.canRedo }

    var selectedAnnotation: Annotation? {
        guard let selectedIndex, annotations.indices.contains(selectedIndex) else { return nil }
        return annotations[selectedIndex]
    }

    var editorEscapeWouldAct: Bool { selectedIndex != nil }

    func handleEditorEscape() {
        cancelAnnotationDrag()
        selectedIndex = nil
    }

    func addAnnotation(_ shape: Annotation.Shape) {
        history.add(Annotation(shape, color: annotationColor))
        refreshImage()
    }

    /// History moves indices arbitrarily, so the selection drops.
    func undoAnnotation() {
        cancelAnnotationDrag()
        selectedIndex = nil
        history.undo()
        refreshImage()
    }

    func redoAnnotation() {
        cancelAnnotationDrag()
        selectedIndex = nil
        history.redo()
        refreshImage()
    }

    func annotationIndex(at point: CGPoint) -> Int? {
        annotationMetrics.flatMap { history.annotationIndex(at: point, metrics: $0) }
    }

    func selectAnnotation(at point: CGPoint) {
        cancelAnnotationDrag()
        selectedIndex = annotationIndex(at: point)
    }

    func deleteSelectedAnnotation() {
        guard let selectedIndex else { return }
        deleteAnnotation(at: selectedIndex)
    }

    /// A selection elsewhere survives: later indices shift down by one.
    func deleteAnnotation(at index: Int) {
        guard annotations.indices.contains(index) else { return }
        cancelAnnotationDrag()
        if let selected = selectedIndex {
            selectedIndex = selected == index ? nil : (selected > index ? selected - 1 : selected)
        }
        history.removeAnnotation(at: index)
        refreshImage()
    }

    /// One stroke width per press, Shift's five; one undo step each.
    func nudgeSelectedAnnotation(_ direction: CGVector, multiplier: CGFloat) {
        guard annotationDrag == nil, let selectedIndex, let annotation = selectedAnnotation,
              let metrics = annotationMetrics
        else { return }
        let step = metrics.strokeWidth * multiplier
        history.replaceAnnotation(
            at: selectedIndex,
            with: annotation.translated(by: CGVector(dx: direction.dx * step, dy: direction.dy * step))
        )
        refreshImage()
    }

    /// The same exclude-one base and renderer-drawn overlay as the Editor's
    /// move, so the shape riding the cursor is what release commits.
    func beginAnnotationDrag(at point: CGPoint) -> Bool {
        cancelAnnotationDrag()
        guard let selectedIndex, let annotation = selectedAnnotation,
              let metrics = annotationMetrics, let pixelSize = capturePixelSize,
              annotation.hitTest(point, metrics: metrics),
              let overlay = annotation.renderedAlone(canvasSize: pixelSize)
        else { return false }
        annotationDrag = AnnotationDrag(annotation: annotation, overlayImage: NSImage(cgImage: overlay, size: pixelSize))
        refreshImage(excludingAnnotationAt: selectedIndex)
        return true
    }

    func updateAnnotationDrag(offset: CGVector) {
        annotationDrag?.offset = CGVector(dx: offset.dx.rounded(), dy: offset.dy.rounded())
    }

    func endAnnotationDrag() {
        guard let drag = annotationDrag else { return }
        annotationDrag = nil
        if drag.offset != .zero, let selectedIndex, selectedAnnotation == drag.annotation {
            history.replaceAnnotation(at: selectedIndex, with: drag.annotation.translated(by: drag.offset))
        }
        refreshImage()
    }

    private func cancelAnnotationDrag() {
        guard annotationDrag != nil else { return }
        annotationDrag = nil
        refreshImage()
    }

    private func refreshImage(excludingAnnotationAt excluded: Int? = nil) {
        guard let image = try? decoded.annotated(with: annotations, excludingAnnotationAt: excluded) else { return }
        capturedImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
    }
}
