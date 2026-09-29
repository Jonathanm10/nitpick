import AppKit
import Foundation
import NitpickCore
import SwiftUI

// Dev-only NITPICK_SNAPSHOT_* seams. Prints here are the proof package's measurements.
// Like the other seams they are not behind `#if DEBUG`; none of them calls send or file itself.

@MainActor
enum WindowSnapshot {
    /// `NITPICK_SNAPSHOT_SIZE=WxH` renders an offscreen, never-key copy of the
    /// main view at exactly that size instead of the real window: layout QA
    /// no longer depends on the window manager (a tiler can pin the real
    /// frame), and the inactive-window look the designer sees while working
    /// in the Simulator is deterministic.
    static let requestedSize: NSSize? = {
        guard let value = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_SIZE"] else { return nil }
        let parts = value.split(separator: "x").compactMap { Double($0) }
        guard parts.count == 2 else { return nil }
        return NSSize(width: parts[0], height: parts[1])
    }()

    private static var offscreenWindow: NSWindow?

    /// Hosts a second `ContentView` over the same model in a borderless
    /// window parked off every screen. Called once, after launch restored
    /// the session, so the copy renders the same state as the real window.
    static func stageOffscreenCopy(model: AppModel) {
        guard offscreenWindow == nil, let size = requestedSize else { return }
        let window = NSWindow(
            contentRect: NSRect(origin: CGPoint(x: -10_000, y: 0), size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: ContentView(model: model, isSnapshotCopy: true))
        window.orderFront(nil)
        offscreenWindow = window
    }

    static func scheduleIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_PATH"] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            if let window = offscreenWindow, let size = requestedSize {
                // Start-review growth resizes the copy too; pin it back first.
                window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                    guard let view = window.contentView,
                          let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
                    else { return }
                    view.cacheDisplay(in: view.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?
                        .write(to: URL(fileURLWithPath: path))
                }
                return
            }
            guard let window = NSApp.nitpickMainWindow
                ?? NSApp.windows.filter({ !$0.isSheet }).max(by: { $0.frame.width < $1.frame.width }),
                  let rep = snapshot(of: window)
            else { return }
            try? rep.representation(using: .png, properties: [:])?
                .write(to: URL(fileURLWithPath: path))
        }
    }

    /// Attached sheets are separate windows `cacheDisplay` omits, so each is
    /// composited at its on-screen offset.
    private static func snapshot(of window: NSWindow) -> NSBitmapImageRep? {
        guard let frame = window.contentView?.superview,
              let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds)
        else { return nil }
        frame.cacheDisplay(in: frame.bounds, to: rep)
        var sheet = window.attachedSheet
        guard sheet != nil, let context = NSGraphicsContext(bitmapImageRep: rep) else { return rep }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        while let current = sheet {
            if let sheetView = current.contentView?.superview,
               let sheetRep = sheetView.bitmapImageRepForCachingDisplay(in: sheetView.bounds) {
                sheetView.cacheDisplay(in: sheetView.bounds, to: sheetRep)
                let origin = CGPoint(
                    x: current.frame.minX - window.frame.minX,
                    y: current.frame.minY - window.frame.minY
                )
                sheetRep.draw(in: CGRect(origin: origin, size: current.frame.size))
                print("snapshot: sheet \(current.frame.width)×\(current.frame.height) pt at \(origin)")
                fflush(stdout)
            }
            sheet = current.attachedSheet
        }
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }
}

extension AppModel {
    /// A staged `NITPICK_SNAPSHOT_FEEDBACK` state other than "not-connected"
    /// shows the form without a saved connection; the seam never calls send.
    var isFeedbackConnected: Bool {
        if let state = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_FEEDBACK"] {
            return state != "not-connected"
        }
        return youTrack != nil
    }

    func stageFeedbackSnapshot(_ state: String) async {
        await presentFeedback()
        guard let feedback else { return }
        guard state != "not-connected" else {
            print("feedback snapshot: state=\(state) connected=\(isFeedbackConnected)")
            fflush(stdout)
            return
        }
        if state != "editing-empty" {
            feedback.title = "Capture button stays disabled after ⌘S"
            feedback.description = """
                After pressing ⌘S the Capture button greys out and never comes back.
                Switching devices re-enables it.
                """
        }
        let sampleURL = URL(string: "https://youtrack.example.com/issue/NIT-42")!
        switch state {
        case "editing":
            // The toggle and the discard dialog need the sheet on screen first.
            try? await Task.sleep(for: .seconds(1.5))
            feedback.setAttachesWindowImage(true)
            if let png = feedback.windowImagePNG, let path = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_PATH"] {
                try? png.write(to: URL(fileURLWithPath: path).deletingPathExtension().appendingPathExtension("window-image.png"))
            }
        case "sending":
            feedback.phase = .sending
        case "sent":
            feedback.phase = .sent(SentFeedback(idReadable: "NIT-42", url: sampleURL))
        case "sent-warning":
            feedback.phase = .sent(SentFeedback(
                idReadable: "NIT-42",
                url: sampleURL,
                warnings: [
                    "The \(FeedbackKind.bug.tagName) tag could not be applied.",
                    "The window image could not be attached.",
                ]
            ))
        case "failed":
            feedback.phase = .failed(message: YouTrackError.permissionDenied(action: "create an issue in Nitpick").localizedDescription)
        case "failed-not-found":
            feedback.phase = .failed(message: YouTrackError.projectNotFound(shortName: AppCore.feedbackProjectShortName).localizedDescription)
        case "discard":
            try? await Task.sleep(for: .seconds(1.5))
            feedback.discardConfirmationRequested = true
        default:
            break
        }
        print("feedback snapshot: state=\(state) canSend=\(feedback.canSend) hasText=\(feedback.payload.hasText)")
        fflush(stdout)
    }
}
