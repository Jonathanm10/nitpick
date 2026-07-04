import Foundation
import NitpickCore
import Testing

/// Annotation editing through the app core's public API: the four tools,
/// the fixed palette, and undo/redo — all observable as Finding state.
/// Annotations stay editable until the Finding is filed.
@Suite("Annotation editing")
struct AnnotationEditingTests {
    static func finding() -> Finding {
        Finding(
            summary: "Button color is off",
            description: "",
            screenshotPNG: Data([0x89, 0x50, 0x4E, 0x47]),
            deviceContext: DeviceContext(deviceModel: "iPhone 17 Pro", osName: "iOS 26.4")
        )
    }

    static let pen = Annotation(.pen(points: [CGPoint(x: 10, y: 10), CGPoint(x: 40, y: 60)]))
    static let arrow = Annotation(.arrow(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 200, y: 150)), color: .blue)
    static let rectangle = Annotation(.rectangle(CGRect(x: 20, y: 30, width: 120, height: 80)), color: .green)
    static let label = Annotation(.label("2pt off", at: CGPoint(x: 50, y: 200)), color: .black)

    @Test("a new Finding carries no Annotations and nothing to undo")
    func pristine() {
        let finding = Self.finding()
        #expect(finding.annotations.isEmpty)
        #expect(!finding.canUndo)
        #expect(!finding.canRedo)
    }

    @Test("all four tools add, in order, with their palette colors")
    func fourTools() {
        var finding = Self.finding()
        finding.add(Self.pen)
        finding.add(Self.arrow)
        finding.add(Self.rectangle)
        finding.add(Self.label)
        #expect(finding.annotations == [Self.pen, Self.arrow, Self.rectangle, Self.label])
        #expect(finding.annotations[0].color == .red)  // the default
        #expect(finding.annotations[1].color == .blue)
    }

    @Test("the palette is small, fixed, and red-first")
    func palette() {
        #expect(AnnotationColor.default == .red)
        #expect(AnnotationColor.allCases.first == .red)
        #expect(AnnotationColor.allCases.count == 6)
    }

    @Test("an edit replaces in place; undo restores the previous shape")
    func editAndUndo() {
        var finding = Self.finding()
        finding.add(Self.pen)
        finding.add(Self.label)

        let moved = Annotation(.label("2pt off", at: CGPoint(x: 80, y: 220)), color: .black)
        finding.replaceAnnotation(at: 1, with: moved)
        #expect(finding.annotations == [Self.pen, moved])

        finding.undo()
        #expect(finding.annotations == [Self.pen, Self.label])
        #expect(finding.canRedo)
    }

    @Test("undo walks back each step; redo replays; a fresh edit clears redo")
    func undoRedo() {
        var finding = Self.finding()
        finding.add(Self.pen)
        finding.add(Self.arrow)

        finding.undo()
        #expect(finding.annotations == [Self.pen])
        finding.undo()
        #expect(finding.annotations.isEmpty)
        #expect(!finding.canUndo)

        finding.redo()
        #expect(finding.annotations == [Self.pen])

        finding.add(Self.rectangle)
        #expect(finding.annotations == [Self.pen, Self.rectangle])
        #expect(!finding.canRedo)  // the replayed future is gone
    }

    @Test("undo and redo with nothing to do are no-ops, not crashes")
    func undoRedoNoOps() {
        var finding = Self.finding()
        finding.undo()
        finding.redo()
        #expect(finding.annotations.isEmpty)

        finding.add(Self.pen)
        finding.redo()
        #expect(finding.annotations == [Self.pen])
    }

    @Test("removing an Annotation is undoable")
    func removeAndUndo() {
        var finding = Self.finding()
        finding.add(Self.pen)
        finding.add(Self.arrow)

        finding.removeAnnotation(at: 0)
        #expect(finding.annotations == [Self.arrow])

        finding.undo()
        #expect(finding.annotations == [Self.pen, Self.arrow])
    }

    @Test("edit history never affects Finding equality — only observable state does")
    func equalityIgnoresHistory() {
        var edited = Self.finding()
        edited.add(Self.pen)
        edited.undo()

        #expect(edited == Self.finding())

        edited.redo()
        var direct = Self.finding()
        direct.add(Self.pen)
        #expect(edited == direct)
    }
}
