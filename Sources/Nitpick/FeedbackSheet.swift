import AppKit
import NitpickCore
import SwiftUI

/// The Feedback sheet (glossary: Feedback), opened from Help ▸ Send
/// Feedback… over the main window in any app state. One sheet, five
/// phases: not connected (points at Settings), editing, sending, sent
/// (Issue ID + Open in YouTrack), and failed (the form again, text kept,
/// error shown). Closing with unsent text asks first; nothing is drafted.
struct FeedbackSheet: View {
    @Bindable var model: AppModel

    @Environment(\.openSettings) private var openSettings

    /// Fixed so the Environment block and preview lay out the same in every
    /// phase; the sheet never resizes as the designer types.
    static let width: CGFloat = 520

    @Bindable private var feedback: FeedbackModel

    init(model: AppModel) {
        self.model = model
        feedback = model.feedback
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Send Feedback")
                .font(.title3.weight(.semibold))
            switch feedback.phase {
            case .notConnected:
                notConnected
            case .sent(let sent):
                sentConfirmation(sent)
            case .editing, .sending, .failed:
                form
            }
        }
        .padding(20)
        .frame(width: Self.width, alignment: .leading)
        .background(NitpickTheme.window)
        // Every close goes through `requestClose`, so no system gesture can
        // drop typed text without the confirmation.
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
        // Connecting in Settings while the sheet waits turns it into the
        // form, without closing and reopening.
        .onChange(of: model.youTrack != nil) { _, connected in
            if connected, feedback.phase == .notConnected { feedback.phase = .editing }
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
                Button("Cancel", role: .cancel) { close() }
                    .keyboardShortcut(.cancelAction)
                    .motionPressFeedback()
                Button("Open Settings…") {
                    close()
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
                    Task { await model.sendFeedback() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!feedback.canSend)
                .motionPressFeedback()
            }
        }
        // Frozen while the send is in flight: the text sent is the text
        // shown. Cancel and Send are already off in that phase.
        .disabled(feedback.phase == .sending)
    }

    /// Read-only, so the designer knows exactly what leaves the machine
    /// (PRD story 4) — the same lines, in the same order, as the Issue's
    /// Environment section.
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
            // The Issue exists either way; a retry would duplicate it, so a
            // step that did not land is said plainly instead of failing.
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
                // Escape closes too: nothing is left to lose once sent.
                Button("Done") { close() }
                    .keyboardShortcut(.cancelAction)
                    .motionPressFeedback()
            }
        }
    }

    // MARK: Closing

    /// Cancel and Escape (the cancel-action shortcut) land here: text on
    /// screen stages "Discard feedback?", an empty form just closes.
    private func requestClose() {
        if feedback.closeNeedsConfirmation {
            feedback.discardConfirmationRequested = true
        } else {
            close()
        }
    }

    private func close() {
        model.isFeedbackSheetPresented = false
    }
}

/// Draws the main window's content into a PNG in-process. Not
/// `ImageRenderer`: on macOS it renders every AppKit-backed control (buttons,
/// text fields, pickers, the Tray's `List`) as a yellow placeholder, which
/// made the image useless as evidence. `cacheDisplay` draws the real view
/// hierarchy at the window's backing scale and, like `ImageRenderer`, never
/// reads the screen — no Screen Recording permission, no system prompt.
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
    /// The window the `main` WindowGroup shows — where the Feedback sheet
    /// attaches. SwiftUI derives window identifiers from the scene id. The
    /// key window wins when several main windows are open, so the sheet and
    /// the window image follow the one the designer is looking at.
    var nitpickMainWindow: NSWindow? {
        let isMain = { (window: NSWindow) in window.identifier?.rawValue.hasPrefix("main") == true && !window.isSheet }
        if let key = keyWindow, isMain(key) { return key }
        return windows.first(where: isMain)
    }
}
