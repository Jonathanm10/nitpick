import AppKit
import NitpickCore
import SwiftUI

struct FeedbackSheet: View {
    @Bindable var feedback: FeedbackModel
    /// Read on every render, so connecting in Settings while the sheet is
    /// open swaps the not-connected state for the form.
    let isConnected: Bool

    @Environment(\.openSettings) private var openSettings
    @Environment(\.dismiss) private var dismiss

    static let width: CGFloat = 520

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let image = annotatingImage {
                Text("Annotate Window Image")
                    .font(.title3.weight(.semibold))
                annotating(image)
            } else {
                Text("Send Feedback")
                    .font(.title3.weight(.semibold))
                switch feedback.phase {
                case .sent(let sent):
                    sentConfirmation(sent)
                case .sending:
                    form
                case .editing, .failed:
                    if isConnected { form } else { notConnected }
                }
            }
        }
        .padding(20)
        .frame(width: annotatingImage == nil ? Self.width : nil, alignment: .leading)
        .background(NitpickTheme.window)
        .interactiveDismissDisabled()
        .confirmationDialog(
            "Discard feedback?",
            isPresented: $feedback.discardConfirmationRequested
        ) {
            Button("Discard", role: .destructive) { close() }
                .motionPressFeedback()
            Button("Keep Editing", role: .cancel) {}
                .motionPressFeedback()
        } message: {
            Text("What you wrote and drew will be lost.")
        }
    }

    // MARK: Not connected

    private var notConnected: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect YouTrack in Settings to send feedback. It is filed as an Issue in the nitpick project with your own token.")
                .foregroundStyle(NitpickTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { requestClose() }
                    .keyboardShortcut(.cancelAction)
                    .motionPressFeedback()
                // Text survives only if the sheet does: disconnecting
                // mid-edit lands here with the draft still in the model.
                Button("Open Settings…") {
                    if !feedback.closeNeedsConfirmation { close() }
                    openSettings()
                }
                .keyboardShortcut(.defaultAction)
                .motionPressFeedback()
            }
        }
    }

    // MARK: Editing, sending, failed

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Kind", selection: $feedback.kind) {
                Text("Bug").tag(FeedbackKind.bug)
                Text("Improvement").tag(FeedbackKind.improvement)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()

            Text("Title")
                .nitpickSectionLabel()
            TextField("What happened, or what should change?", text: $feedback.title)
                .nitpickField(minHeight: 34)

            Text("Description")
                .nitpickSectionLabel()
            TextEditor(text: $feedback.description)
                .font(NitpickTheme.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 7)
                .padding(.vertical, 7)
                .frame(height: 96)
                .background(NitpickTheme.raised, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall))
                .overlay {
                    RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall)
                        .strokeBorder(NitpickTheme.strongBorder, lineWidth: 1)
                }

            environmentBlock

            Toggle("Attach window image", isOn: Binding(
                get: { feedback.attachesWindowImage },
                set: { feedback.setAttachesWindowImage($0) }
            ))
            .toggleStyle(.checkbox)
            if let image = feedback.windowImage, let preview = image.capturedImage {
                HStack(alignment: .top, spacing: 12) {
                    Button { feedback.isAnnotatingWindowImage = true } label: {
                        Image(nsImage: preview)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 150, alignment: .leading)
                            .overlay {
                                RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall)
                                    .strokeBorder(NitpickTheme.border, lineWidth: 1)
                            }
                    }
                    .buttonStyle(.plain)
                    .help("Annotate the window image")
                    .accessibilityLabel("Preview of the attached window image")
                    VStack(alignment: .leading, spacing: 6) {
                        Button("Annotate…") { feedback.isAnnotatingWindowImage = true }
                            .motionPressFeedback()
                        Text(image.annotations.isEmpty
                            ? "Point at what you mean."
                            : "^[\(image.annotations.count) annotation](inflect: true)")
                            .font(NitpickTheme.secondary)
                            .foregroundStyle(NitpickTheme.secondaryText)
                    }
                }
            }

            if let message = feedback.failureMessage {
                Text(message)
                    .foregroundStyle(NitpickTheme.error)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                if feedback.phase == .sending {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending…")
                        .foregroundStyle(NitpickTheme.secondaryText)
                }
                Spacer()
                Button("Cancel", role: .cancel) { requestClose() }
                    .keyboardShortcut(.cancelAction)
                    .motionPressFeedback()
                Button("Send") {
                    Task { await feedback.send() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!feedback.canSend)
                .motionPressFeedback()
            }
        }
        .disabled(feedback.phase == .sending)
    }

    private var environmentBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Environment")
                .nitpickSectionLabel()
            VStack(alignment: .leading, spacing: 3) {
                ForEach(feedback.environment.lines, id: \.label) { line in
                    Text("•  \(line.label): \(line.value)")
                        .font(NitpickTheme.secondary)
                        .foregroundStyle(NitpickTheme.secondaryText)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(NitpickTheme.inset, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall))
        }
    }

    // MARK: Annotating

    private var annotatingImage: AnnotatedImageModel? {
        guard isConnected, feedback.isFormEditable, feedback.isAnnotatingWindowImage else { return nil }
        return feedback.windowImage
    }

    /// Room the toolbar and its spacing take above the image.
    private static let toolbarAllowance: CGFloat = 50

    /// The window image under the Editor's own surface and toolbar, sized
    /// to fill most of the main window the sheet hangs from.
    private func annotating(_ image: AnnotatedImageModel) -> some View {
        let size = Self.annotatingImageSize(for: image.capturePixelSize ?? CGSize(width: 1, height: 1))
        return VStack(alignment: .leading, spacing: 12) {
            AnnotationSurface(model: image)
                .frame(width: size.width, height: size.height + Self.toolbarAllowance)
            HStack {
                Text("Annotations are drawn into the attached image.")
                    .font(NitpickTheme.secondary)
                    .foregroundStyle(NitpickTheme.secondaryText)
                Spacer()
                // A placed label commits on Return; leaving first would drop it.
                Button("Done") { feedback.isAnnotatingWindowImage = false }
                    .keyboardShortcut(.defaultAction)
                    .disabled(image.hasPendingLabelDraft)
                    .motionPressFeedback()
            }
        }
        .onExitCommand {
            if !image.hasPendingLabelDraft { feedback.isAnnotatingWindowImage = false }
        }
    }

    /// Aspect-fits the image into the main window less the sheet's chrome,
    /// never narrower than the form, whose width fits the toolbar.
    private static func annotatingImageSize(for pixelSize: CGSize) -> CGSize {
        let window = NSApp.nitpickMainWindow?.contentLayoutRect.size ?? CGSize(width: 920, height: 640)
        let bounds = CGSize(width: max(window.width - 80, width - 40), height: max(window.height - 220, 200))
        let scale = min(bounds.width / pixelSize.width, bounds.height / pixelSize.height)
        return CGSize(
            width: max((pixelSize.width * scale).rounded(.down), width - 40),
            height: (pixelSize.height * scale).rounded(.down)
        )
    }

    // MARK: Sent

    private func sentConfirmation(_ sent: SentFeedback) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text("Sent as \(sent.idReadable)")
                    .font(NitpickTheme.emphasis)
                    .textSelection(.enabled)
            }
            if !sent.warnings.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(sent.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(NitpickTheme.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Text("Thanks — the nitpick team triages it on the board.")
                .foregroundStyle(NitpickTheme.secondaryText)
            HStack {
                Spacer()
                Button("Open in YouTrack") { NSWorkspace.shared.open(sent.url) }
                    .motionPressFeedback()
                Button("Done") { close() }
                    .keyboardShortcut(.cancelAction)
                    .motionPressFeedback()
            }
        }
    }

    // MARK: Closing

    private func requestClose() {
        if feedback.closeNeedsConfirmation {
            feedback.discardConfirmationRequested = true
        } else {
            close()
        }
    }

    private func close() {
        dismiss()
    }
}

/// `cacheDisplay`, not `ImageRenderer`: on macOS the latter draws AppKit-backed
/// controls as placeholders. Neither reads the screen, so no Screen Recording
/// permission is involved.
@MainActor
enum WindowImageRenderer {
    static func mainWindowPNG() -> Data? {
        guard let view = NSApp.nitpickMainWindow?.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
        else { return nil }
        view.cacheDisplay(in: view.bounds, to: rep)
        return rep.representation(using: .png, properties: [:])
    }
}

extension NSApplication {
    /// SwiftUI derives window identifiers from the scene id ("main").
    var nitpickMainWindow: NSWindow? {
        let isMain = { (window: NSWindow) in window.identifier?.rawValue.hasPrefix("main") == true && !window.isSheet }
        if let key = keyWindow, isMain(key) { return key }
        return windows.first(where: isMain)
    }
}
