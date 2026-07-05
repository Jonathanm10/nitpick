import CoreGraphics
import Foundation
import NitpickCore
import Testing

/// Rigid translation of an Annotation: the whole shape moves by the offset,
/// relative geometry preserved — nothing resizes or reshapes (PRD move
/// semantics, Q2). Expected positions are independent literals, never
/// recomputed the way the code does.
@Suite("Annotation rigid translation")
struct AnnotationTranslationTests {
    let offset = CGVector(dx: 40, dy: -25)

    @Test("a pen stroke moves every point")
    func penStroke() {
        let moved = Annotation(
            .pen(points: [CGPoint(x: 10, y: 20), CGPoint(x: 30, y: 80), CGPoint(x: 55, y: 25)]),
            color: .blue
        ).translated(by: offset)
        #expect(moved.shape == .pen(points: [
            CGPoint(x: 50, y: -5), CGPoint(x: 70, y: 55), CGPoint(x: 95, y: 0)
        ]))
        #expect(moved.color == .blue)
    }

    @Test("an arrow keeps its head at the head")
    func arrow() {
        let moved = Annotation(.arrow(from: CGPoint(x: 100, y: 200), to: CGPoint(x: 160, y: 120)))
            .translated(by: offset)
        #expect(moved.shape == .arrow(from: CGPoint(x: 140, y: 175), to: CGPoint(x: 200, y: 95)))
    }

    @Test("a rectangle keeps its size")
    func rectangle() {
        let moved = Annotation(.rectangle(CGRect(x: 60, y: 500, width: 240, height: 160)))
            .translated(by: offset)
        #expect(moved.shape == .rectangle(CGRect(x: 100, y: 475, width: 240, height: 160)))
    }

    @Test("a label keeps its text at the moved anchor")
    func label() {
        let moved = Annotation(.label("2pt off", at: CGPoint(x: 100, y: 700)), color: .black)
            .translated(by: offset)
        #expect(moved.shape == .label("2pt off", at: CGPoint(x: 140, y: 675)))
        #expect(moved.color == .black)
    }

    @Test("a zero offset is the identity")
    func identity() {
        let annotation = Annotation(.pen(points: [CGPoint(x: 10, y: 20)]), color: .green)
        #expect(annotation.translated(by: .zero) == annotation)
    }
}
