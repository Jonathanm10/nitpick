import CoreGraphics
import Foundation

/// `target` and `generation` never change in place: pointing the Editor
/// elsewhere builds a fresh value, so every field, one added later
/// included, starts over on every capture, tray selection, and close.
public struct EditorState: Equatable, Sendable {
    /// Nil hides the Editor.
    public let target: TrayItem.ID?
    /// New with every value: the shell's `captureID`, which resets the
    /// annotation surface's in-flight draft even when two targets share a
    /// pixel size, and the stamp an Annotation selection carries.
    public let generation: UUID
    /// A placed, uncommitted text label pins the Editor: retargeting first
    /// would land its commit on the wrong Finding.
    public var hasPendingLabelDraft = false
    public var designSnapshotError: String?

    /// Never refused, unlike `selecting`: the shell's capture gate already
    /// refuses a pinned Editor.
    public init(opening target: TrayItem.ID? = nil) {
        self.target = target
        generation = UUID()
    }

    public func selecting(_ item: TrayItem.ID, in session: ReviewSession?) -> EditorState? {
        guard target != item, !hasPendingLabelDraft,
              session?.tray.contains(where: { $0.id == item }) == true
        else { return nil }
        return EditorState(opening: item)
    }

    /// Never while work runs: filing works on a copy of the session.
    public func allowsDiscard(during activity: ShellActivity) -> Bool {
        !hasPendingLabelDraft && !activity.isBusy
    }
}

/// Workspace chrome, never persisted, never flattened into any PNG. Its
/// `generation` ties it to the Editor target it was made on, so a retarget
/// can tell the selection it left behind.
public struct AnnotationSelection<Overlay> {
    public let generation: UUID
    public let index: Int
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

/// What Esc does in the Editor (PRD stories 10, 11): release an in-flight
/// or selected Annotation first, otherwise discard a pristine Finding, the
/// mis-capture case.
public enum EditorEscape: Equatable, Sendable {
    case releaseAnnotation
    case discard(TrayItem.ID)

    /// The editor scope at large, where a text field may hold focus, never
    /// releases a selection, so Esc in Summary or Description keeps
    /// standard field behavior.
    public static func inEditor(
        _ editor: EditorState,
        session: ReviewSession?,
        activity: ShellActivity
    ) -> EditorEscape? {
        guard editor.allowsDiscard(during: activity),
              let target = editor.target,
              let item = session?.tray.first(where: { $0.id == target }),
              item.isPristine
        else { return nil }
        return .discard(item.id)
    }

    public static func onSurface<Overlay>(
        _ editor: EditorState,
        selection: AnnotationSelection<Overlay>?,
        session: ReviewSession?,
        activity: ShellActivity
    ) -> EditorEscape? {
        if let selection, selection.belongs(to: editor) { return .releaseAnnotation }
        return inEditor(editor, session: session, activity: activity)
    }
}
