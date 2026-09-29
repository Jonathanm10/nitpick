import AppKit
import Foundation
import NitpickCore

// Dev-only NITPICK_SNAPSHOT_* seams. Prints here are the proof package's measurements.

@MainActor
enum WindowSnapshot {
    static func scheduleIfRequested() {
        guard let path = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_PATH"] else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
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
    func stageFeedbackSnapshot(_ state: String) async {
        await presentFeedback()
        guard state != "not-connected" else {
            feedback.phase = .notConnected
            print("feedback snapshot: state=\(state)")
            fflush(stdout)
            return
        }
        feedback.phase = .editing
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
        case "discard":
            try? await Task.sleep(for: .seconds(1.5))
            feedback.discardConfirmationRequested = true
        default:
            break
        }
        print("feedback snapshot: state=\(state) canSend=\(feedback.canSend) hasText=\(feedback.hasText)")
        fflush(stdout)
    }
}
