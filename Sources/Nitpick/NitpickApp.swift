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
    }
}
