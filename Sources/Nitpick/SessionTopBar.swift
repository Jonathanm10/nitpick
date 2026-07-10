import NitpickCore
import SwiftUI

/// The in-session topbar (device-selection redesign): the "unified pill". One
/// flat inset surface carries only what is live and actionable — the device
/// (its tap opens the shared DeviceList), a status dot, and the session's one
/// contextual action. Build identity is deliberately *not* repeated here: the
/// window's `navigationSubtitle` already carries version and project a few
/// pixels above, and duplicating it was most of what made the old bar heavy.
///
/// The one filled-accent action on the whole screen is File all, down in the
/// inspector — so the pill's Capture stays a prominent-but-quiet `.bordered`
/// button (⌘S is the global capture hotkey, ADR-0006; the keycap is a hint).
struct SessionTopBar: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(spacing: 12) {
            DeviceContextChip(model: model)
            separator
            status
            Spacer(minLength: 8)
            action
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .frame(minHeight: 40)
        .background(NitpickTheme.inset, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusLarge))
        .overlay {
            RoundedRectangle(cornerRadius: NitpickTheme.radiusLarge)
                .strokeBorder(NitpickTheme.border, lineWidth: 1)
        }
    }

    private var separator: some View {
        Rectangle()
            .fill(NitpickTheme.strongBorder)
            .frame(width: 1, height: 18)
    }

    /// A dot plus a word — the accent-tinted status pill is gone. The dot is
    /// live-green while reviewing, quiet otherwise.
    private var status: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(model.isReviewing ? Color.green : NitpickTheme.strongBorder)
                .frame(width: 8, height: 8)
            Text(model.isReviewing ? "Review in progress" : "Ready to resume")
                .font(NitpickTheme.secondary)
                .foregroundStyle(NitpickTheme.secondaryText)
                .lineLimit(1)
        }
    }

    /// Contextual: Start review (the one filled-accent action) when a session
    /// is restored but paused; Capture once reviewing.
    @ViewBuilder
    private var action: some View {
        if !model.isReviewing {
            Button(model.startReviewTitle) {
                Task { await model.startReview() }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
            .disabled(!model.canStartReview)
            .help("Reviewing needs a device and a YouTrack project — the session files into it.")
            .motionPressFeedback()
        } else {
            Button {
                Task { await model.captureScreen() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "camera")
                    Text("Capture")
                    Text("⌘S")
                        .font(.system(size: 11).monospaced())
                        .foregroundStyle(.tertiary)
                }
            }
            .buttonStyle(.bordered)
            .disabled(!model.canCapture)
            .help("Capture the current screen (⌘S).")
            .motionPressFeedback()
        }
    }
}
