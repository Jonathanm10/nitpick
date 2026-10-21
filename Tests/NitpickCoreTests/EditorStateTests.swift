import Foundation
import NitpickCore
import Testing

/// The Editor's target and the state that belongs to it: a capture, a tray
/// selection, and a close each start the Editor over in one assignment.
@Suite("Editor retargeting")
struct EditorStateTests {
    static func session(findings count: Int) -> (session: ReviewSession, ids: [TrayItem.ID]) {
        var session = IssueFilingTests.session
        let ids = (0..<count).map { session.addFinding(IssueFilingTests.finding(summary: "Finding \($0)")) }
        return (session, ids)
    }

    @Test("a capture opens a fresh editor with a new captureID and no label draft")
    func captureOpensAFreshEditor() throws {
        let (session, ids) = Self.session(findings: 2)
        var editor = try #require(EditorState().selecting(ids[0], in: session))
        editor.hasPendingLabelDraft = true

        let next = editor.capturing(ids[1])

        #expect(next.target == ids[1])
        #expect(next.generation != editor.generation)
        #expect(!next.hasPendingLabelDraft)
    }

    @Test("a capture never shows the previous Finding's Design Snapshot error")
    func captureClearsTheDesignSnapshotError() throws {
        let (session, ids) = Self.session(findings: 2)
        var editor = try #require(EditorState().selecting(ids[0], in: session))
        editor.designSnapshotError = "Moodboard.gif: unsupported format"

        #expect(editor.capturing(ids[1]).designSnapshotError == nil)
    }

    @Test("a tray selection opens a fresh editor and clears the Design Snapshot error")
    func selectionOpensAFreshEditor() throws {
        let (session, ids) = Self.session(findings: 2)
        var editor = try #require(EditorState().selecting(ids[0], in: session))
        editor.designSnapshotError = "Moodboard.gif: unsupported format"

        let next = try #require(editor.selecting(ids[1], in: session))

        #expect(next.target == ids[1])
        #expect(next.generation != editor.generation)
        #expect(next.designSnapshotError == nil)
        #expect(!next.hasPendingLabelDraft)
    }

    @Test("a tray selection is refused while a label draft pins the editor")
    func selectionIsRefusedWhileALabelDraftPins() throws {
        let (session, ids) = Self.session(findings: 2)
        var editor = try #require(EditorState().selecting(ids[0], in: session))
        editor.hasPendingLabelDraft = true

        #expect(editor.selecting(ids[1], in: session) == nil)
    }

    @Test("selecting the current target, or with no open session, is refused")
    func selectionIsRefusedForTheTargetOrWithoutASession() throws {
        let (session, ids) = Self.session(findings: 2)
        let editor = try #require(EditorState().selecting(ids[0], in: session))

        #expect(editor.selecting(ids[0], in: session) == nil)
        #expect(editor.selecting(ids[1], in: nil) == nil)
    }

    @Test("closing the editor drops the target, the label draft, and the Design Snapshot error")
    func closingStartsOver() throws {
        let (session, ids) = Self.session(findings: 1)
        var editor = try #require(EditorState().selecting(ids[0], in: session))
        editor.hasPendingLabelDraft = true
        editor.designSnapshotError = "Moodboard.gif: unsupported format"

        let closed = EditorState()

        #expect(closed.target == nil)
        #expect(closed.generation != editor.generation)
        #expect(!closed.hasPendingLabelDraft)
        #expect(closed.designSnapshotError == nil)
    }

    @Test("an Annotation selection belongs only to the target it was made on")
    func selectionBelongsOnlyToItsTarget() throws {
        let (session, ids) = Self.session(findings: 2)
        let editor = try #require(EditorState().selecting(ids[0], in: session))
        let selection = AnnotationSelection<Int>(index: 0, in: editor)
        var drafting = editor
        drafting.hasPendingLabelDraft = true

        #expect(selection.belongs(to: drafting))
        #expect(!selection.belongs(to: editor.capturing(ids[1])))
        #expect(try !selection.belongs(to: #require(editor.selecting(ids[1], in: session))))
        #expect(!selection.belongs(to: EditorState()))
    }
}

/// Deleting an Annotation keeps the selection on the same shape: removal
/// shifts later indices down by one.
@Suite("Annotation selection after a delete")
struct AnnotationSelectionDeleteTests {
    static let editor = EditorState()

    @Test("deleting an earlier Annotation shifts the selection down by one")
    func earlierDeleteShiftsDown() {
        let selection = AnnotationSelection<Int>(index: 2, in: Self.editor)

        #expect(selection.removingAnnotation(at: 0)?.index == 1)
    }

    @Test("deleting a later Annotation keeps the selection")
    func laterDeleteKeepsIndex() {
        let selection = AnnotationSelection<Int>(index: 0, in: Self.editor)

        #expect(selection.removingAnnotation(at: 2)?.index == 0)
    }

    @Test("deleting the selected Annotation drops the selection")
    func selectedDeleteDropsSelection() {
        let selection = AnnotationSelection<Int>(index: 2, in: Self.editor)

        #expect(selection.removingAnnotation(at: 2) == nil)
    }

    @Test("a delete drops an in-flight drag and keeps the selection on its target")
    func deleteDropsTheDrag() throws {
        var selection = AnnotationSelection<Int>(index: 3, in: Self.editor)
        selection.drag = AnnotationDrag(annotation: Annotation(.rectangle(CGRect(x: 1, y: 2, width: 3, height: 4))), overlayImage: 7)

        let next = try #require(selection.removingAnnotation(at: 1))

        #expect(next.index == 2)
        #expect(next.drag == nil)
        #expect(next.belongs(to: Self.editor))
    }
}
