import Foundation
import NitpickCore
import Testing

/// Esc in the Editor (PRD stories 10, 11): the surface's focus scope
/// releases an Annotation selection first, else discards a pristine
/// Finding; the editor scope, where a text field may hold focus, only ever
/// discards. A Finding with work in it never dies on Esc.
@Suite("Editor Esc rule")
struct EditorEscapeTests {
    static func editor(summary: String = "") throws -> (EditorState, ReviewSession, TrayItem.ID) {
        var session = IssueFilingTests.session
        let id = session.addFinding(IssueFilingTests.finding(summary: summary, description: ""))
        return (try #require(EditorState().selecting(id, in: session)), session, id)
    }

    @Test("on the surface, a selected Annotation is released before a pristine Finding is discarded")
    func surfaceReleasesTheSelectionFirst() throws {
        let (editor, session, _) = try Self.editor()
        let selection = AnnotationSelection<Int>(index: 0, in: editor)

        #expect(EditorEscape.onSurface(editor, selection: selection, session: session, activity: ShellActivity())
            == .releaseAnnotation)
    }

    @Test("on the surface with nothing selected, a pristine Finding is discarded")
    func surfaceDiscardsAPristineFinding() throws {
        let (editor, session, id) = try Self.editor()

        #expect(EditorEscape.onSurface(editor, selection: AnnotationSelection<Int>?.none, session: session, activity: ShellActivity())
            == .discard(id))
    }

    @Test("a selection made on an earlier target does not block the discard")
    func staleSelectionDoesNotBlockTheDiscard() throws {
        let (editor, session, id) = try Self.editor()
        let stale = AnnotationSelection<Int>(index: 0, in: EditorState())

        #expect(EditorEscape.onSurface(editor, selection: stale, session: session, activity: ShellActivity())
            == .discard(id))
    }

    @Test("the editor scope discards a pristine Finding and never releases a selection")
    func editorScopeOnlyDiscards() throws {
        let (editor, session, id) = try Self.editor()

        #expect(EditorEscape.inEditor(editor, session: session, activity: ShellActivity()) == .discard(id))
    }

    @Test("a Finding with a summary is never discarded, from either scope")
    func investedFindingIsKept() throws {
        let (editor, session, _) = try Self.editor(summary: "Header title sits 4 pt too high")

        #expect(EditorEscape.inEditor(editor, session: session, activity: ShellActivity()) == nil)
        #expect(EditorEscape.onSurface(editor, selection: AnnotationSelection<Int>?.none, session: session, activity: ShellActivity())
            == nil)
    }

    @Test("Esc never discards while File all runs")
    func noDiscardWhileFiling() throws {
        let (editor, session, _) = try Self.editor()
        var filing = ShellActivity()
        _ = filing.begin(.filing)

        #expect(EditorEscape.inEditor(editor, session: session, activity: filing) == nil)
        #expect(EditorEscape.onSurface(editor, selection: AnnotationSelection<Int>?.none, session: session, activity: filing) == nil)
    }

    @Test("Esc never discards while a label draft pins the editor")
    func noDiscardWithALabelDraft() throws {
        var (editor, session, _) = try Self.editor()
        editor.hasPendingLabelDraft = true

        #expect(EditorEscape.inEditor(editor, session: session, activity: ShellActivity()) == nil)
    }

    @Test("with no Finding in the editor, Esc does nothing")
    func noTargetNoAction() {
        let session = IssueFilingTests.session

        #expect(EditorEscape.inEditor(EditorState(), session: session, activity: ShellActivity()) == nil)
        #expect(EditorEscape.onSurface(EditorState(), selection: AnnotationSelection<Int>?.none, session: session, activity: ShellActivity())
            == nil)
    }
}
