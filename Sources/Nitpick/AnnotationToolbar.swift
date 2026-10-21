import NitpickCore
import SwiftUI

/// The annotation toolbar: tool picker, colors, undo/redo. A standalone
/// view so the frozen pane can reserve its exact slot (hidden, disabled)
/// and render a filed capture at the same size the editable surface
/// gives it (issue 01: "same pane, same size").
struct AnnotationToolbar: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(spacing: 14) {
            Picker("Tool", selection: $model.annotationTool) {
                ForEach(AnnotationTool.allCases) { tool in
                    Image(systemName: tool.symbolName)
                        .accessibilityLabel(tool.title)
                        .help(tool.help)
                        .tag(tool)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            HStack(spacing: 7) {
                ForEach(AnnotationColor.allCases, id: \.self) { color in
                    Button {
                        model.annotationColor = color
                    } label: {
                        Circle()
                            .fill(color.swatch)
                            .strokeBorder(
                                .primary.opacity(model.annotationColor == color ? 0.9 : 0.2),
                                lineWidth: model.annotationColor == color ? 2 : 1
                            )
                            .frame(width: 18, height: 18)
                    }
                    .buttonStyle(.plain)
                    .help(color.rawValue.capitalized)
                    .accessibilityLabel(color.rawValue.capitalized)
                    .accessibilityAddTraits(model.annotationColor == color ? .isSelected : [])
                    .motionPressFeedback()
                }
            }
            Rectangle()
                .fill(NitpickTheme.border)
                .frame(width: 1, height: 22)
            Spacer()

            Button {
                if !Self.sendToFocusedText("undo:") { model.undoAnnotation() }
            } label: {
                Image(systemName: "arrow.uturn.backward")
            }
            .keyboardShortcut("z", modifiers: .command)
            .disabled(!model.canUndoAnnotation)
            .help("Undo Annotation (⌘Z)")
            .accessibilityLabel("Undo Annotation")
            .motionPressFeedback()
            Button {
                if !Self.sendToFocusedText("redo:") { model.redoAnnotation() }
            } label: {
                Image(systemName: "arrow.uturn.forward")
            }
            .keyboardShortcut("z", modifiers: [.command, .shift])
            .disabled(!model.canRedoAnnotation)
            .help("Redo Annotation (⇧⌘Z)")
            .accessibilityLabel("Redo Annotation")
            .motionPressFeedback()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(NitpickTheme.raised, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusMedium))
        .overlay {
            RoundedRectangle(cornerRadius: NitpickTheme.radiusMedium)
                .strokeBorder(NitpickTheme.border, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.08), radius: 5, x: 0, y: 2)
    }

    /// On macOS ⌘Z belongs to the focused text field, so a key-triggered
    /// Undo or Redo goes down the responder chain to its field editor
    /// instead of the annotations. A click always acts on the annotations.
    private static func sendToFocusedText(_ action: String) -> Bool {
        guard NSApp.currentEvent?.type == .keyDown,
              NSApp.keyWindow?.firstResponder is NSText
        else { return false }
        NSApp.sendAction(Selector(action), to: nil, from: nil)
        return true
    }
}
