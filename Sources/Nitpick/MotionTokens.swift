import SwiftUI

/// The shell's motion vocabulary: one validated token set, kept in the view
/// layer so NitpickCore stays motion-free. Policy lives here once: named
/// tokens carry the timing, and `reducedMotionAware(_:reduceMotion:)` lets a
/// use site collapse positional motion to opacity when the accessibility
/// reduce-motion environment says to.
enum MotionTokens {
    /// Press acknowledgment — the tiny, immediate response every pressable
    /// control gets, including under Reduce Motion.
    static let press = Animation.easeOut(duration: 0.14)

    /// Rows, popovers, and staggered entrances.
    static let enter = Animation.timingCurve(0.23, 1, 0.32, 1, duration: 0.25)

    /// The capture arriving in the Editor.
    static let arrive = Animation.timingCurve(0.77, 0, 0.175, 1, duration: 0.32)

    /// Filing checkmarks.
    static let pop = Animation.spring(duration: 0.26, bounce: 0.35)

    /// Central Reduce Motion policy: positional transitions opt out of motion
    /// and become opacity fades; meaning-carrying feedback keeps its token.
    static func reducedMotionAware(_ transition: AnyTransition, reduceMotion: Bool) -> AnyTransition {
        reduceMotion ? .opacity : transition
    }
}

private struct MotionPressFeedbackModifier: ViewModifier {
    var scale: CGFloat = 0.97
    @GestureState private var isPressed = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isPressed ? scale : 1)
            .animation(MotionTokens.press, value: isPressed)
            .simultaneousGesture(pressGesture)
    }

    private var pressGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .updating($isPressed) { _, state, _ in
                state = true
            }
    }
}

extension View {
    /// Layers press feedback onto the native control rendering instead of
    /// replacing it; use it on buttons and links that should visibly hear a
    /// click.
    func motionPressFeedback(scale: CGFloat = 0.97) -> some View {
        modifier(MotionPressFeedbackModifier(scale: scale))
    }
}
