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
        .defaultSize(width: 560, height: 760)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Check for Updates…") { updater.checkForUpdates() }
                    .disabled(!updater.canCheckForUpdates)
            }
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

/// Running from `swift run` there is no app bundle, so the process starts as
/// a background executable; promote it to a regular, activated app.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }
}
