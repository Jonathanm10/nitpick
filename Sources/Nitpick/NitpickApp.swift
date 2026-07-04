import AppKit
import SwiftUI

@main
struct NitpickApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup("nitpick") {
            ContentView(model: model)
        }
        .defaultSize(width: 560, height: 760)
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
