import AppKit
import SwiftUI

@main
struct NitpickApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    @State private var updater = UpdaterModel()

    var body: some Scene {
        WindowGroup("nitpick", id: "main") {
            // The Feedback sheet hangs off the main window so Help ▸ Send
            // Feedback… reaches it from every ContentView state.
            ContentView(model: model)
                .sheet(isPresented: $model.isFeedbackSheetPresented) {
                    FeedbackSheet(model: model)
                }
        }
        .defaultSize(width: 1140, height: 760)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
            ReviewCommands(model: model)
            FeedbackCommands(model: model)
        }

        Window("History", id: "history") {
            HistoryWindow(model: model)
        }
        .defaultSize(width: 680, height: 520)
        .keyboardShortcut("y")

        // The standard Settings scene: ⌘, and the app-menu item for free.
        // It owns the YouTrack connection (issue 01) and never opens on
        // its own — launch with no connection hints on home instead.
        Settings {
            SettingsView(model: model)
        }
    }
}

struct ReviewCommands: Commands {
    @Bindable var model: AppModel

    var body: some Commands {
        CommandMenu("Review") {
            Button(model.startReviewTitle) {
                Task { await model.startReview() }
            }
            .keyboardShortcut("r", modifiers: [.command])
            .disabled(!model.canStartReview)

            Button("Capture") {
                Task { await model.captureScreen() }
            }
            .keyboardShortcut("s", modifiers: [.command])
            .disabled(!model.canCapture)

            Button("File All") {
                Task { await model.fileAllFindings() }
            }
            .disabled(!model.canFileAll)

            Button("End Review") {
                model.requestEndReview()
            }
            .disabled(!model.canEndReview)
        }
    }
}

/// Help ▸ Send Feedback… (glossary: Feedback) — where macOS apps put it.
/// Never disabled: without a connection the sheet itself explains and
/// points at Settings. The sheet attaches to the main window, so a closed
/// one is reopened and a buried one brought forward first.
struct FeedbackCommands: Commands {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .help) {
            Button("Send Feedback…") {
                if let window = NSApp.nitpickMainWindow, window.isVisible {
                    window.makeKeyAndOrderFront(nil)
                } else {
                    openWindow(id: "main")
                }
                Task { await model.presentFeedback() }
            }
        }
    }
}

/// Running from `swift run` there is no app bundle, so the process starts as
/// a background executable; promote it to a regular, activated app.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        // nitpick's palette is a bespoke light theme (near-white window, white
        // fields). Its text leans on adaptive semantic colors, so under system
        // Dark Mode every label resolves light and vanishes on the light
        // surfaces. Pin the whole app to aqua so appearance matches the design.
        NSApp.appearance = NSAppearance(named: .aqua)

        // Dev-only: NITPICK_SNAPSHOT_PATH renders the main window to a PNG
        // five seconds after launch. In-process (`cacheDisplay`), so staged
        // screenshots need no Screen Recording permission; pairs with
        // NITPICK_WORKSPACE for README/QA staging against a seeded store.
        // Attached sheets (NITPICK_SNAPSHOT_FEEDBACK) are separate windows
        // `cacheDisplay` omits, so each is rendered and composited at its
        // on-screen offset.
        if let path = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_PATH"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                guard let window = NSApp.nitpickMainWindow
                    ?? NSApp.windows.filter({ !$0.isSheet }).max(by: { $0.frame.width < $1.frame.width }),
                      let rep = Self.snapshot(of: window)
                else { return }
                try? rep.representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: path))
            }
        }
    }

    @MainActor
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
