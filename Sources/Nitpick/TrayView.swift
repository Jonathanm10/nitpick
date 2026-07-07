import NitpickCore
import SwiftUI

/// The tray lives in a List so the platform owns the swipe physics, full-swipe
/// commit, and reduced-motion behavior for PRD stories 17–18. The list sizes
/// to its rows — the column reads top-down: tray, File all, compose — and
/// only past the visible cap does it become a scroll region; an unbounded
/// List would swallow the column's spare height and orphan everything below.
struct TrayView: View {
    let tray: [TrayItem]
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Hover reveals the unfiled row's Discard affordance (design handoff:
    /// "unfiled: 'Discard' on hover"); selection keeps it reachable without
    /// a pointer, and the swipe action stays for full-swipe discard.
    @State private var hoveredItemID: UUID?

    private struct TrayMotionKey: Equatable {
        var id: UUID
        var filedIssueID: String?
    }

    /// Rows are single-line by construction (lineLimit(1) everywhere), so a
    /// fixed height is honest and lets the List be content-sized: SwiftUI
    /// can't otherwise measure a List's intrinsic height.
    private static let rowHeight: CGFloat = 32
    /// Past this many rows the tray scrolls instead of growing.
    private static let visibleRowCap = 8

    var body: some View {
        List {
            // Capture order is the core's truth (filing walks the tray in
            // order, ADR-0004); the DISPLAY is newest-first so a fresh
            // capture's row slides into the top of the Tray, where the
            // designer's eye already is (PRD story 6).
            ForEach(tray.reversed()) { item in
                trayRow(item)
                    .frame(height: Self.rowHeight)
                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .transition(trayRowTransition)
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
        .environment(\.defaultMinListRowHeight, Self.rowHeight)
        .contentMargins(.vertical, 0, for: .scrollContent)
        .scrollDisabled(tray.count <= Self.visibleRowCap)
        .frame(height: Self.rowHeight * CGFloat(min(tray.count, Self.visibleRowCap)))
        .animation(MotionTokens.enter, value: trayAnimationKey)
    }

    // PRD story 19: the tray's view-side key follows row identity and the
    // filed/not-filed boundary, so inserts, removals, and filing completion
    // re-settle without teaching AppModel about motion.
    private var trayAnimationKey: [TrayMotionKey] {
        tray.map { TrayMotionKey(id: $0.id, filedIssueID: $0.filedIssue?.idReadable) }
    }

    private var trayRowTransition: AnyTransition {
        MotionTokens.reducedMotionAware(
            .move(edge: .top).combined(with: .opacity),
            reduceMotion: reduceMotion
        )
    }

    private func trayRow(_ item: TrayItem) -> some View {
        let isSelected = model.selectedItemID == item.id
        let isHovered = hoveredItemID == item.id
        return HStack(spacing: 8) {
            let summary = item.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
            Text(summary.isEmpty ? "Untitled Finding" : summary)
                .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                .lineLimit(1)
                .layoutPriority(3)
            Text(item.finding.deviceContext.deviceModel)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(NitpickTheme.secondaryText)
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 4)
            if let filed = item.filedIssue {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.green)
                    Link(filed.idReadable, destination: filed.url)
                        .motionPressFeedback()
                }
                .font(.system(size: 13))
                .transition(
                    MotionTokens.reducedMotionAware(
                        .scale.combined(with: .opacity),
                        reduceMotion: reduceMotion
                    )
                )
            } else if item.isEditable {
                if isHovered || isSelected {
                    Button("Discard") { model.discardFinding(id: item.id) }
                        .buttonStyle(.borderless)
                        .font(.system(size: 13))
                        .disabled(model.isBusy || model.hasPendingLabelDraft)
                        .motionPressFeedback()
                }
            } else {
                // Mid-ladder: its issue exists but is incomplete — a File all
                // retry finishes it without re-creating anything. After a
                // failed run this frozen row is where the failure lives, so
                // it carries the error itself (PRD story 22).
                if model.isBusy {
                    Text("Filing…")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                } else if model.filingStoppedByFailure, let message = model.errorMessage {
                    Text(message)
                        .font(.system(size: 13))
                        .foregroundStyle(.red)
                        .lineLimit(1)
                        .help(message)
                } else {
                    Text("Filing interrupted — retry")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(.horizontal, 10)
        .animation(MotionTokens.pop, value: item.filedIssue)
        .contentShape(Rectangle())
        .onHover { hovering in
            if hovering {
                hoveredItemID = item.id
            } else if hoveredItemID == item.id {
                hoveredItemID = nil
            }
        }
        .onTapGesture { model.selectItem(item.id) }
        .background(
            RoundedRectangle(cornerRadius: NitpickTheme.radiusMedium)
                .fill(rowBackground(isSelected: isSelected, isHovered: isHovered))
        )
        .overlay {
            RoundedRectangle(cornerRadius: NitpickTheme.radiusMedium)
                .strokeBorder(isSelected ? Color.accentColor.opacity(0.16) : .clear, lineWidth: 1)
        }
    }

    private func rowBackground(isSelected: Bool, isHovered: Bool) -> Color {
        if isSelected {
            return Color.accentColor.opacity(0.10)
        }
        if isHovered {
            return NitpickTheme.hover.opacity(0.65)
        }
        return Color.clear
    }
}
