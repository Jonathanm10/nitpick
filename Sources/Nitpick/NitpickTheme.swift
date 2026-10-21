import AppKit
import NitpickCore
import SwiftUI

enum NitpickTheme {
    static let window = Color(.window)
    static let inset = Color(.inset)
    static let raised = Color(.raised)
    static let hover = Color(.hover)
    static let border = Color(.border)
    static let strongBorder = Color(.strongBorder)
    static let secondaryText = Color(.secondaryText)

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
            .background(NitpickTheme.raised, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall))
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

private extension Color {
    /// A palette colour that resolves per appearance whenever it is drawn.
    init(_ token: ThemeColor) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            let rgb = token.value(in: isDark ? .dark : .light)
            return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        })
    }
}
