import NitpickCore
import SwiftUI

/// The tray lives in a List so the platform owns the swipe physics, full-swipe
/// commit, and reduced-motion behavior for PRD stories 17–18. The list must
/// also stretch to consume the control column's spare height; otherwise it only
/// sizes to its contents and never becomes a proper scroll region.
struct TrayView: View {
    let tray: [TrayItem]
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        List {
            ForEach(tray) { item in
                trayRow(item)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    // The swipe is offered exactly where the discard rules
                    // allow the act (PRD story 18): a row filing has touched,
                    // a busy model, or a pending label draft gets no gesture
                    // at all — an empty builder removes the affordance.
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        if item.isEditable, !model.isBusy, !model.hasPendingLabelDraft {
                            Button(role: .destructive) {
                                model.discardFinding(id: item.id)
                            } label: {
                                Label("Discard", systemImage: "trash")
                            }
                        }
                    }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .frame(maxHeight: .infinity, alignment: .topLeading)
    }

    private func trayRow(_ item: TrayItem) -> some View {
        HStack(spacing: 8) {
            let summary = item.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            Text(summary.isEmpty ? "Untitled Finding" : summary)
                .lineLimit(1)
            Text(item.finding.deviceContext.deviceModel)
                .foregroundStyle(.secondary)
            Spacer()
            if let filed = item.filedIssue {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.green)
                    Link(filed.idReadable, destination: filed.url)
                }
                .font(.callout)
                .transition(
                    MotionTokens.reducedMotionAware(
                        .scale.combined(with: .opacity),
                        reduceMotion: reduceMotion
                    )
                )
            } else if item.isEditable {
                Button("Discard") { model.discardFinding(id: item.id) }
                    .buttonStyle(.borderless)
                    .disabled(model.isBusy || model.hasPendingLabelDraft)
                    .motionPressFeedback()
            } else {
                // Mid-ladder: its issue exists but is incomplete — a File all
                // retry finishes it without re-creating anything. After a
                // failed run this frozen row is where the failure lives, so
                // it carries the error itself (PRD story 22).
                if model.isBusy {
                    Text("Filing…")
                        .foregroundStyle(.orange)
                } else if model.filingStoppedByFailure, let message = model.errorMessage {
                    Text(message)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                        .help(message)
                } else {
                    Text("Filing interrupted — retry")
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 6)
        .animation(MotionTokens.pop, value: item.filedIssue)
        .contentShape(Rectangle())
        .onTapGesture { model.selectItem(item.id) }
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(model.selectedItemID == item.id ? Color.accentColor.opacity(0.15) : .clear)
        )
    }
}

