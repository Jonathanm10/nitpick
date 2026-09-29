import SwiftUI

enum NitpickTheme {
    static let window = Color(red: 251 / 255, green: 251 / 255, blue: 252 / 255)
    static let inset = Color(red: 244 / 255, green: 245 / 255, blue: 247 / 255)
    static let hover = Color(red: 236 / 255, green: 238 / 255, blue: 241 / 255)
    static let border = Color(red: 227 / 255, green: 229 / 255, blue: 234 / 255)
    static let strongBorder = Color(red: 212 / 255, green: 215 / 255, blue: 222 / 255)
    static let secondaryText = Color(red: 93 / 255, green: 99 / 255, blue: 111 / 255)

    static let radiusSmall: CGFloat = 5
    static let radiusMedium: CGFloat = 7
    static let radiusLarge: CGFloat = 10
    static let inspectorMinWidth: CGFloat = 300
    static let inspectorIdealWidth: CGFloat = 380
    /// The gutter between the capture pane and the inspector's content; the
    /// column's divider sits at its leading edge.
    static let inspectorGutter: CGFloat = 24
    /// The capture pane's first claim on the session split: the width the
    /// window's 920pt minimum leaves it beside a minimum-width inspector. That
    /// is room for the annotation toolbar (about 460pt, fixed) and a portrait
    /// capture at about device-point size.
    static let capturePaneMinWidth: CGFloat = 548

    /// The inspector's width for a session split of `splitWidth` points. An
    /// explicit rule, because a flexible min/ideal/max frame never lands on
    /// its ideal inside an HStack: a concrete proposal resolves it to the
    /// minimum or maximum. The capture pane keeps its `capturePaneMinWidth`,
    /// then the inspector takes the next width up to its ideal, and any width
    /// beyond that goes to the capture pane. The inspector drops to its
    /// minimum only on a window too narrow for both.
    static func inspectorWidth(forSplitWidth splitWidth: CGFloat) -> CGFloat {
        let spare = splitWidth - inspectorGutter - capturePaneMinWidth
        return min(max(spare, inspectorMinWidth), inspectorIdealWidth)
    }

    // Type scale. macOS control text is 13pt (`NSFont.systemFontSize`); the
    // session screen aligns to it rather than sitting oversized above it. Three
    // steps — the genuinely app-wide-portable bit of the visual language.
    static let emphasis = Font.system(size: 13, weight: .semibold)
    static let body = Font.system(size: 13)
    static let secondary = Font.system(size: 12)
}

private struct NitpickFieldModifier: ViewModifier {
    var minHeight: CGFloat
    /// Where the content sits once `minHeight` makes the field taller than
    /// its content. A single line centers vertically (`.leading`). A
    /// multi-line field must pass `.topLeading`, so its first line starts
    /// under its label, not halfway down an empty box.
    var alignment: Alignment

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(NitpickTheme.body)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .frame(minHeight: minHeight, alignment: alignment)
            .background(.white, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall))
            .overlay {
                RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall)
                    .strokeBorder(NitpickTheme.strongBorder, lineWidth: 1)
            }
    }
}

private struct NitpickSectionLabelModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.system(size: 12, weight: .semibold))
            .textCase(.uppercase)
            .kerning(0.6)
            .foregroundStyle(NitpickTheme.secondaryText)
    }
}

extension View {
    func nitpickField(minHeight: CGFloat = 32, alignment: Alignment = .leading) -> some View {
        modifier(NitpickFieldModifier(minHeight: minHeight, alignment: alignment))
    }

    func nitpickSectionLabel() -> some View {
        modifier(NitpickSectionLabelModifier())
    }
}
