import Foundation

/// The designer's most-recently-reviewed simulator devices, newest first —
/// the source of the device picker's Recent section and of the launch
/// preselection. A testable utility, not a domain term (kept out of
/// CONTEXT.md): it stores only UDIDs, holds no device metadata, and is
/// recorded on a successful launch only, so a stray selection or a
/// reverted switch never enters Recent.
public struct RecentDevices: Equatable, Sendable {
    /// The reviewed device UDIDs, most-recent first, deduplicated and
    /// capped at `capacity`.
    public private(set) var udids: [String]

    /// How many devices Recent keeps — the handful worth a quick pick;
    /// older entries age out.
    public static let capacity = 3

    /// Loads from a persisted list, enforcing the invariants at the
    /// boundary: deduplicated, most-recent first, capped. Untrusted stored
    /// data can never widen the list past `capacity`.
    public init(udids: [String] = []) {
        var seen = Set<String>()
        var deduped: [String] = []
        for udid in udids where seen.insert(udid).inserted {
            deduped.append(udid)
        }
        self.udids = Array(deduped.prefix(Self.capacity))
    }

    /// Records a launch on `udid`: promotes it to the front, drops any
    /// earlier occurrence, and caps the list at `capacity`.
    public mutating func record(_ udid: String) {
        udids.removeAll { $0 == udid }
        udids.insert(udid, at: 0)
        if udids.count > Self.capacity {
            udids.removeLast(udids.count - Self.capacity)
        }
    }

    /// The Recent devices to offer, in most-recent-first order: the
    /// stored UDIDs resolved to entries that are present in `available`
    /// and whose runtime is installed. A runtime-missing recent is
    /// dropped — Recent only offers devices the designer can actually
    /// launch (PRD story 8).
    public func resolved(among available: [SimulatorDevice]) -> [SimulatorDevice] {
        udids.compactMap { udid in
            available.first { $0.udid == udid && $0.isRuntimeAvailable }
        }
    }

    /// The device to preselect at launch: the most-recent still-runtime-
    /// available device, else the first runtime-available device (today's
    /// rule) when Recent is empty or all its devices are gone. Never
    /// returns a runtime-missing device.
    public func preferredDevice(among available: [SimulatorDevice]) -> SimulatorDevice? {
        resolved(among: available).first
            ?? available.first { $0.isRuntimeAvailable }
    }
}
