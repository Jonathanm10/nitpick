import Combine
import Foundation
import Observation
import Sparkle

/// The Sparkle updater behind the "Check for Updates…" menu item.
///
/// Sparkle only works inside a real `.app` bundle — the feed URL and EdDSA
/// public key live in Info.plist, and the installer replaces a bundle on
/// disk. Under `swift run` there is no bundle, so the updater never starts
/// and the menu item stays disabled instead of throwing Sparkle's
/// missing-configuration alert at a developer.
@MainActor
@Observable
final class UpdaterModel {
    private(set) var canCheckForUpdates = false

    private let controller: SPUStandardUpdaterController
    @ObservationIgnored private var subscription: AnyCancellable?

    init() {
        let isBundled = Bundle.main.bundleURL.pathExtension == "app"
        controller = SPUStandardUpdaterController(
            startingUpdater: isBundled,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        // Sparkle drives this KVO on the main thread; the hop makes the
        // isolation assumption unconditionally safe regardless.
        subscription = controller.updater
            .publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] canCheck in
                MainActor.assumeIsolated { self?.canCheckForUpdates = canCheck }
            }
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}
