import NitpickCore
import SwiftUI

/// The tray lives in a List for its content-sized scrolling: it is the control
/// column's first scroll region — a flexible frame lets it sit at its
/// row-count-capped natural height when there is room and compress toward a
/// ~2-row floor when the compose fields need the space, scrolling once rows
/// are hidden. A lower layoutPriority than compose (set at the use site) makes
/// the tray yield and scroll before compose does (compose scrolls only as the
/// column's last resort, once the tray sits at its floor); an unbounded
/// List would instead swallow the column's spare height and orphan the fields
/// below it. Discard is a hover/selection × per row, not a swipe (ADR-0010):
/// swipe-to-act is a touch idiom, undiscoverable on a pointer-driven Mac list.
struct TrayView: View {
    let tray: [TrayItem]
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Hover reveals the unfiled row's Discard ×; selection keeps it reachable
    /// without a pointer. Either way the × stages the confirmation below rather
    /// than acting — a Finding leaves the tray only once the designer confirms.
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

    /// One tray row, squeezed in a fixed order when the inspector is narrow.
    /// The status (filed Issue ID, filing state, the needs-a-summary mark and
    /// Discard ×) claims its width first and never truncates, because an
    /// Issue ID cut to one character or "Filing interrupted" wrapped into
    /// "F / il" reads as noise. The device model yields next, then the
    /// summary truncates. A long filing error is the one status allowed to
    /// truncate: it shares the title's priority, so the two split the width
    /// and neither is erased (its `.help` keeps the full message).
    private func trayRow(_ item: TrayItem) -> some View {
        let isSelected = model.selectedItemID == item.id
        let isHovered = hoveredItemID == item.id
        return HStack(spacing: 8) {
            rowTitle(item, isSelected: isSelected)
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
                .fixedSize()
                .layoutPriority(2)
                .transition(
                    MotionTokens.reducedMotionAware(
                        .scale.combined(with: .opacity),
                        reduceMotion: reduceMotion
                    )
                )
            } else if item.isEditable {
                HStack(spacing: 8) {
                    if model.findingsNeedingSummary.contains(item.id) {
                        NeedsSummaryMark()
                    }
                    // Discard is a hover/selection × (ADR-0010) that stages
                    // the confirmation — never a one-click destroy. Gated
                    // exactly as the old swipe was: no × while a File all run
                    // is busy or a label draft is pending.
                    if isHovered || isSelected {
                        TrayDiscardButton(
                            disabled: model.isBusy || model.hasPendingLabelDraft
                        ) {
                            pendingDiscardID = item.id
                        }
                    }
                }
                .fixedSize()
                .layoutPriority(2)
            } else {
                // Mid-ladder: its issue exists but is incomplete — a File all
                // retry finishes it without re-creating anything. After a
                // failed run this frozen row is where the failure lives, so
                // it carries the error itself (PRD story 22).
                if model.isBusy {
                    Text("Filing…")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                        .fixedSize()
                        .layoutPriority(2)
                } else if model.filingStoppedByFailure, let message = model.errorMessage {
                    Text(message)
                        .font(.system(size: 13))
                        .foregroundStyle(.red)
                        .lineLimit(1)
                        .layoutPriority(1)
                        .help(message)
                } else {
                    Text("Filing interrupted — retry")
                        .font(.system(size: 13))
                        .foregroundStyle(.orange)
                        .fixedSize()
                        .layoutPriority(2)
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

    /// The summary, followed by the Device Context's model only when both fit
    /// whole. `ViewThatFits` drops the device outright instead of letting it
    /// shrink: a model name cut to "il" or "iPho…" says nothing, while the
    /// summary still reads when truncated. A layout priority can't express
    /// that, since it only picks who shrinks first, never who disappears.
    private func rowTitle(_ item: TrayItem, isSelected: Bool) -> some View {
        let summary = item.finding.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = Text(summary.isEmpty ? "Untitled Finding" : summary)
            .font(.system(size: 13, weight: isSelected ? .medium : .regular))
            .lineLimit(1)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                title
                Text(item.finding.deviceContext.deviceModel)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(NitpickTheme.secondaryText)
                    .lineLimit(1)
            }
            title
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

/// Marks a row whose Finding keeps File all disabled because it has no
/// summary. The same orange glyph leads the reason line under File all, so
/// the designer can match the reason to its rows at a glance.
private struct NeedsSummaryMark: View {
    var body: some View {
        Image(systemName: "exclamationmark.circle.fill")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.orange)
            .help("Needs a summary before it can be filed")
            .accessibilityLabel("Needs a summary")
    }
}

/// The per-row Discard control (ADR-0010): a small × that picks up a faint
/// circular hover background. It owns its own hover state so it darkens under
/// the pointer independent of the row highlight, and stages the tray's
/// confirmation — it never discards on the click itself.
private struct TrayDiscardButton: View {
    let disabled: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(NitpickTheme.secondaryText)
                .frame(width: 18, height: 18)
                .background(hovering ? NitpickTheme.hover : .clear, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .onHover { hovering = $0 }
        .help("Discard Finding")
        // The glyph carries no text, so name the destructive action for
        // VoiceOver — .help alone is only a pointer tooltip.
        .accessibilityLabel("Discard Finding")
        .motionPressFeedback()
    }
}
