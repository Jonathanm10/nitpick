import NitpickCore
import SwiftUI

/// The in-place filing result: after a File all fully succeeds, the finished
/// Review Session stays here as History's newest entry — the shared
/// `HistoryRow`, read-only, every Finding paired with its Issue link — until
/// the designer chooses Done (or drops the next Build). No timed
/// disappearance, no Editor or annotation chrome: nothing here can alter a
/// Finding whose Issue already exists.
struct FilingResultView: View {
    let entry: HistoryEntry
    let onDone: () -> Void

    @State private var revealed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if revealed {
                HistoryRow(entry: entry)
                    .transition(entranceTransition)
            }
            Spacer(minLength: 0)
            HStack {
                Spacer()
                Button("Done", action: onDone)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .motionPressFeedback()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // Reduced-motion-aware entrance, mirroring the ⌘Y window's rows
        // (PRD story 19): positional motion collapses to a fade when the
        // accessibility environment asks for it.
        .animation(reduceMotion ? nil : MotionTokens.enter, value: revealed)
        .onAppear { revealed = true }
    }

    private var entranceTransition: AnyTransition {
        MotionTokens.reducedMotionAware(
            .move(edge: .top).combined(with: .opacity),
            reduceMotion: reduceMotion
        )
    }
}
