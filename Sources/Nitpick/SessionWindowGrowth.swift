import AppKit
import SwiftUI

/// One-shot window growth at Start review (issue 03): when a Review Session
/// opens — freshly started, resumed, or restored at launch — the window grows
/// once to a fixed comfortable session size, capped at the screen's visible
/// frame. In that slot an iPhone portrait capture aspect-fits at roughly
/// device-point size (PRD Q1). The size is a constant by decision (PRD Q5):
/// the selected simulator device carries no point-size or scale metadata, and
/// a device lookup table was rejected.
///
/// Growth discipline: geometry changes only at this one ceremony. The window
/// never auto-shrinks — session end, capture, discard, and device switch
/// leave it alone — and the designer's own resizes win for the rest of the
/// session: nothing here observes the frame after the one-shot.
struct SessionWindowGrowth: NSViewRepresentable {
    var isSessionOpen: Bool

    /// Fits every current iPhone portrait capture at device points beside
    /// the 320pt control column, with header and toolbar above.
    private static let sessionSize = NSSize(width: 920, height: 980)

    func makeNSView(context: Context) -> NSView { NSView() }

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// Remembers the last session state so growth fires exactly on the
    /// closed→open edge, not on every body re-evaluation.
    final class Coordinator {
        var wasOpen = false
    }

    func updateNSView(_ view: NSView, context: Context) {
        let opened = isSessionOpen && !context.coordinator.wasOpen
        context.coordinator.wasOpen = isSessionOpen
        guard opened else { return }
        // Growing the window mid-update would mutate layout inside SwiftUI's
        // update pass — and the view may not be in a window yet. Hop off.
        Task { @MainActor [weak view] in
            guard let window = view?.window else { return }
            Self.grow(window)
        }
    }

    /// Grows each axis to the session size capped at the screen's visible
    /// frame; an axis already at or beyond stays put — a window at or past
    /// the session size never moves. The top-left corner stays anchored
    /// (AppKit frames grow from the bottom-left), then the frame is nudged
    /// back inside the visible area if growth pushed it past an edge.
    private static func grow(_ window: NSWindow) {
        // A fullscreen window (or tile) is not ours to resize.
        guard !window.styleMask.contains(.fullScreen),
              let screen = window.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var frame = window.frame
        let grown = NSSize(
            width: max(frame.width, min(sessionSize.width, visible.width)),
            height: max(frame.height, min(sessionSize.height, visible.height))
        )
        guard grown != frame.size else { return }
        frame.origin.y -= grown.height - frame.height
        frame.size = grown
        frame.origin.x = max(min(frame.origin.x, visible.maxX - frame.width), visible.minX)
        frame.origin.y = max(min(frame.origin.y, visible.maxY - frame.height), visible.minY)
        window.setFrame(frame, display: true, animate: true)
    }
}
