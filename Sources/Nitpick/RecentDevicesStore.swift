import Foundation
import NitpickCore

/// Persists the device MRU across app launches (PRD story 11), global
/// across Builds. A thin UserDefaults adapter with no logic worth seaming:
/// read once at launch, written after every successful launch.
struct RecentDevicesStore {
    private let defaults: UserDefaults
    private let key = "recentDeviceUDIDs"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> RecentDevices {
        RecentDevices(udids: defaults.stringArray(forKey: key) ?? [])
    }

    func save(_ recent: RecentDevices) {
        defaults.set(recent.udids, forKey: key)
    }
}
