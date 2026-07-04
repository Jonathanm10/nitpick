import CoreGraphics
import Foundation

/// The small fixed palette for Annotations (PRD story 16). Red is the
/// default; the rest keep marks visible on any screenshot. Colors are pinned
/// as exact sRGB components so flattened output stays snapshot-stable.
public enum AnnotationColor: String, CaseIterable, Equatable, Sendable, Codable {
    case red, yellow, green, blue, black, white

    public static let `default` = AnnotationColor.red

    /// sRGB components, for the flattening renderer and the shell's palette
    /// and preview — one source of truth, so previews match filed pixels.
    public var components: (red: CGFloat, green: CGFloat, blue: CGFloat) {
        switch self {
        case .red: (1.00, 0.23, 0.19)
        case .yellow: (1.00, 0.80, 0.00)
        case .green: (0.20, 0.78, 0.35)
        case .blue: (0.00, 0.48, 1.00)
        case .black: (0.00, 0.00, 0.00)
        case .white: (1.00, 1.00, 1.00)
        }
    }
}

/// A markup element laid over a Finding's screenshot: pen stroke, arrow,
/// rectangle, or text label. Coordinates live in the screenshot's native
/// pixel space, origin top-left — annotations are resolution-anchored to
/// the capture, not to any view that displays it.
public struct Annotation: Equatable, Sendable, Codable {
    public enum Shape: Equatable, Sendable, Codable {
        /// A freehand polyline through the given points.
        case pen(points: [CGPoint])
        /// A straight arrow; the head sits at `to`.
        case arrow(from: CGPoint, to: CGPoint)
        /// A stroked (unfilled) rectangle.
        case rectangle(CGRect)
        /// A single line of text; `at` is the top-left corner of the
        /// rendered line.
        case label(String, at: CGPoint)
    }

    public var shape: Shape
    public var color: AnnotationColor

    public init(_ shape: Shape, color: AnnotationColor = .default) {
        self.shape = shape
        self.color = color
    }
}

extension Finding {
    /// Adds an Annotation on top of the existing ones. Undoable; like every
    /// edit, it discards any redoable future.
    public mutating func add(_ annotation: Annotation) {
        recordAnnotationEdit()
        annotations.append(annotation)
    }

    /// Replaces the Annotation at `index` — moving a label, recoloring a
    /// stroke. Undoable.
    public mutating func replaceAnnotation(at index: Int, with annotation: Annotation) {
        recordAnnotationEdit()
        annotations[index] = annotation
    }

    /// Removes the Annotation at `index`. Undoable.
    public mutating func removeAnnotation(at index: Int) {
        recordAnnotationEdit()
        annotations.remove(at: index)
    }

    public var canUndo: Bool { !annotationUndoStack.isEmpty }
    public var canRedo: Bool { !annotationRedoStack.isEmpty }

    /// Steps back one Annotation edit; a no-op when there is nothing to
    /// undo, so a stray ⌘Z never crashes.
    public mutating func undo() {
        guard let previous = annotationUndoStack.popLast() else { return }
        annotationRedoStack.append(annotations)
        annotations = previous
    }

    /// Replays the most recently undone edit; a no-op when there is none.
    public mutating func redo() {
        guard let next = annotationRedoStack.popLast() else { return }
        annotationUndoStack.append(annotations)
        annotations = next
    }

    /// Every edit snapshots the current state onto the undo stack and
    /// invalidates the redo stack — the standard linear-history contract.
    private mutating func recordAnnotationEdit() {
        annotationUndoStack.append(annotations)
        annotationRedoStack.removeAll()
    }
}
