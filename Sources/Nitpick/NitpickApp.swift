import AppKit
import SwiftUI

@main
struct NitpickApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()
    @State private var updater = UpdaterModel()

    var body: some Scene {
        WindowGroup("nitpick") {
            ContentView(model: model)
        }
        .defaultSize(width: 1140, height: 760)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
            ReviewCommands(model: model)
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
        if let path = ProcessInfo.processInfo.environment["NITPICK_SNAPSHOT_PATH"] {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                guard let window = NSApp.windows.max(by: { $0.frame.width < $1.frame.width }),
                      let frame = window.contentView?.superview,
                      let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds)
                else { return }
                frame.cacheDisplay(in: frame.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: path))
            }
        }
    }
}
