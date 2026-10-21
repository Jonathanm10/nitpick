import CoreGraphics
import Foundation

/// What the Editor is pointed at, and the ephemeral state that belongs to
/// that target. `target` and `generation` never change in place: pointing
/// the Editor elsewhere builds a fresh value, so every field, one added
/// later included, starts over on every capture, tray selection, and close.
public struct EditorState: Equatable, Sendable {
    /// The tray item under edit; nil hides the Editor.
    public let target: TrayItem.ID?
    /// New with every value: the shell's `captureID`, which resets the
    /// annotation surface's in-flight draft even when two targets share a
    /// pixel size, and the stamp an Annotation selection carries.
    public let generation: UUID
    /// A placed, uncommitted text label pins the Editor: retargeting first
    /// would land its commit on the wrong Finding.
    public var hasPendingLabelDraft = false
    /// The last Design Snapshot failure on this target.
    public var designSnapshotError: String?

    public init() {
        self.init(target: nil)
    }

    private init(target: TrayItem.ID?) {
        self.target = target
        generation = UUID()
    }

    /// A capture landed: the Editor opens it. Never refused here, since the
    /// shell's capture gate already refuses a pinned Editor.
    public func capturing(_ item: TrayItem.ID) -> EditorState {
        var next = EditorState(target: item)
        next.designSnapshotError = designSnapshotError
        return next
    }

    /// A tray click, or nil when refused: no open session, the item is
    /// already the target, or a label draft pins the Editor.
    public func selecting(_ item: TrayItem.ID, in session: ReviewSession?) -> EditorState? {
        guard session != nil, target != item, !hasPendingLabelDraft else { return nil }
        return EditorState(target: item)
    }
}

/// The Annotation picked with the Select tool, and the rigid move in flight
/// on it: workspace chrome, never persisted, never flattened into any PNG.
/// The shell stores it apart from `EditorState` so a drag tick re-renders
/// only the annotation surface. Its `generation` ties it to the Editor
/// target it was made on, so a retarget orphans it without a second reset.
public struct AnnotationSelection<Overlay> {
    public let generation: UUID
    public let index: Int
    /// A drag exists only inside a selection.
    public var drag: AnnotationDrag<Overlay>?

    public init(index: Int, in editor: EditorState) {
        self.init(generation: editor.generation, index: index)
    }

    private init(generation: UUID, index: Int) {
        self.generation = generation
        self.index = index
    }

    public func belongs(to editor: EditorState) -> Bool {
        generation == editor.generation
    }

    /// The selection once Annotation `removed` is deleted. Any drag is
    /// dropped. The selection dies with its own Annotation, shifts down when
    /// an earlier one goes, and stays when a later one goes.
    public func removingAnnotation(at removed: Int) -> AnnotationSelection? {
        if index == removed { return nil }
        return AnnotationSelection(generation: generation, index: index > removed ? index - 1 : index)
    }
}

/// A rigid move of the selected Annotation, in flight from the first cursor
/// movement on the shape until release. The shape leaves the flattened base
/// (exclude-one render) and rides as a renderer-drawn overlay the view
/// shifts, so it is never double-drawn or ghosted at its old position.
/// Generic over the overlay so the core stays AppKit-free while the shell
/// keeps the image it draws.
public struct AnnotationDrag<Overlay> {
    /// The Annotation as the drag found it: release translates this, and
    /// commits only if it is still in place.
    public let annotation: Annotation
    /// The shape alone on transparency at its pre-drag position, rendered
    /// by the core so the preview is pixel truth.
    public let overlayImage: Overlay
    /// Whole image pixels: the single source for the live preview and the
    /// committed move alike.
    public var offset = CGVector.zero

    public init(annotation: Annotation, overlayImage: Overlay) {
        self.annotation = annotation
        self.overlayImage = overlayImage
    }
}

extension AnnotationSelection: Equatable where Overlay: Equatable {}
extension AnnotationDrag: Equatable where Overlay: Equatable {}
