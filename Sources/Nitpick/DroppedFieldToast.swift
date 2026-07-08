import SwiftUI

/// The transient toast that names a triage field filing couldn't set and
/// the value the designer intended (PRD story 28), so it can be relayed to
/// the dev team by hand. Auto-hides after a beat; a click dismisses it
/// early. Nothing here is persisted — History stays a clean record.
struct DroppedFieldToast: View {
    let message: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(NitpickTheme.secondaryText)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(maxWidth: 440, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: NitpickTheme.radiusLarge))
        .overlay {
            RoundedRectangle(cornerRadius: NitpickTheme.radiusLarge)
                .strokeBorder(NitpickTheme.strongBorder, lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        // Transient by design: the notice clears itself after a beat, so it
        // never lingers into the next review. Cancelled if dismissed first.
        .task(id: message) {
            try? await Task.sleep(for: .seconds(8))
            onDismiss()
        }
    }
}
