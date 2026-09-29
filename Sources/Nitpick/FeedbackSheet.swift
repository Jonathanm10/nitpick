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
        .padding(20)
        .frame(width: Self.width, alignment: .leading)
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
            Text("The title and description you wrote will be lost.")
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
                .background(.white, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall))
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
            if feedback.attachesWindowImage, let image = feedback.windowImage {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 150, alignment: .leading)
                    .overlay {
                        RoundedRectangle(cornerRadius: NitpickTheme.radiusSmall)
                            .strokeBorder(NitpickTheme.border, lineWidth: 1)
                    }
                    .accessibilityLabel("Preview of the attached window image")
            }

            if let message = feedback.failureMessage {
                Text(message)
                    .foregroundStyle(.red)
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
                            .foregroundStyle(.orange)
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
