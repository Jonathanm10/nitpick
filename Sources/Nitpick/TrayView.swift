import NitpickCore
import SwiftUI

/// The tray lives in a List so the platform owns the swipe physics, full-swipe
/// commit, and reduced-motion behavior for PRD stories 17–18. It is the
/// control column's one scroll region: a flexible frame lets it sit at its
/// row-count-capped natural height when there is room and compress toward a
/// ~2-row floor when the fixed compose fields need the space, scrolling once
/// rows are hidden. A lower layoutPriority than compose (set at the use site)
/// makes the tray — not the whole column — yield and scroll; an unbounded
/// List would instead swallow the column's spare height and orphan the fields
/// below it.
struct TrayView: View {
    let tray: [TrayItem]
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Hover reveals the unfiled row's Discard affordance (design handoff:
    /// "unfiled: 'Discard' on hover"); selection keeps it reachable without
    /// a pointer, and the swipe reveals the same Discard. Each of these
    /// stages the confirmation below rather than acting — a Finding leaves
    /// the tray only once the designer confirms.
    @State private var hoveredItemID: UUID?
    /// The Finding a Discard affordance is asking to throw away, staged for
    /// the confirmation. Discard is destructive and the tray keeps no undo,
    /// so no path removes a Finding without this round-trip. Nil except
    /// while the dialog is up.
    @State private var pendingDiscardID: TrayItem.ID?

    private struct TrayMotionKey: Equatable {
        var id: UUID
        var filedIssueID: String?
    }

    /// Rows are single-line by construction (lineLimit(1) everywhere), so a
    /// fixed row height is honest and lets the List be content-sized: SwiftUI
    /// can't otherwise measure a List's intrinsic height.
    private static let rowHeight: CGFloat = 32
    /// Past this many rows the tray scrolls instead of growing.
    private static let visibleRowCap = 8

    /// Every row laid end to end: what the tray would show with no cap and no
    /// pressure. Scrolling engages exactly when the rendered height falls short
    /// of this.
    private var contentHeight: CGFloat { Self.rowHeight * CGFloat(tray.count) }
    /// The tray's natural (uncompressed) height: its content, capped at the
    /// visible row count. The column offers this when it has room to spare.
    private var naturalHeight: CGFloat { Self.rowHeight * CGFloat(min(tray.count, Self.visibleRowCap)) }
    /// The floor a compressed tray never sinks below — ~2 rows, or its whole
    /// content when it holds fewer. Keeps a couple of Findings reachable while
    /// the fixed compose fields hold their place above.
    private var floorHeight: CGFloat { min(Self.rowHeight * 2, naturalHeight) }

    /// The height the column actually granted the List this layout pass,
    /// measured from a background reader. Drives `scrollDisabled`: below the
    /// content height means rows are hidden, so the List must scroll.
    @State private var renderedHeight: CGFloat = 0

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
                    // at all — an empty builder removes the affordance. No
                    // full swipe: a one-gesture instant commit is exactly the
                    // mistaken discard the confirmation guards, so the swipe
                    // only reveals the button and the tap stages the dialog.
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if item.isEditable, !model.isBusy, !model.hasPendingLabelDraft {
                            Button(role: .destructive) {
                                pendingDiscardID = item.id
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
        // Scroll only when rows are actually hidden — past the visible cap, or
        // when the column has compressed the tray below its content. A tray
        // that shows everything stays inert so the trackpad can't rubber-band
        // over nothing.
        .scrollDisabled(renderedHeight + 0.5 >= contentHeight)
        // Flexible, not fixed: the tray sits at its natural (capped) height
        // when the column has room and shrinks toward a ~2-row floor when the
        // fixed compose fields need the space. A lower layoutPriority than
        // compose (set where TrayView is used) makes the tray — and only the
        // tray — the column's scroll region.
        .frame(minHeight: floorHeight, maxHeight: naturalHeight)
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { renderedHeight = proxy.size.height }
                    .onChange(of: proxy.size.height) { renderedHeight = proxy.size.height }
            }
        }
        .animation(MotionTokens.enter, value: trayAnimationKey)
        .confirmationDialog(
            "Discard this Finding?",
            isPresented: Binding(
                get: { pendingDiscardID != nil },
                set: { if !$0 { pendingDiscardID = nil } }
            ),
            presenting: pendingDiscardID
        ) { id in
            Button("Discard", role: .destructive) {
                model.discardFinding(id: id)
            }
            .motionPressFeedback()
            Button("Cancel", role: .cancel) {}
            .motionPressFeedback()
        } message: { id in
            Text(discardConfirmationMessage(for: id))
        }
    }

    /// The confirmation's body: names the Finding when it carries a summary
    /// so the designer can tell which row is about to go, and says the
    /// discard is final — the tray keeps no undo.
    private func discardConfirmationMessage(for id: TrayItem.ID) -> String {
        let summary = tray.first { $0.id == id }?
            .finding.summary.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let subject = summary.isEmpty ? "this Finding" : "“\(summary)”"
        return "Discarding \(subject) removes it from the tray for good."
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
                    Button("Discard") { pendingDiscardID = item.id }
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
