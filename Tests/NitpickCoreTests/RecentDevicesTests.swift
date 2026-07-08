import Foundation
import NitpickCore
import Testing

@Suite("Recent devices MRU + preselection")
struct RecentDevicesTests {
    private func device(_ udid: String, runtimeAvailable: Bool = true) -> SimulatorDevice {
        SimulatorDevice(
            udid: udid,
            name: "Device \(udid)",
            osName: "iOS 26.4",
            isBooted: false,
            isRuntimeAvailable: runtimeAvailable
        )
    }

    @Test("recording promotes to the front, most-recent first")
    func recordsMostRecentFirst() {
        var recent = RecentDevices()
        recent.record("A")
        recent.record("B")
        recent.record("C")
        #expect(recent.udids == ["C", "B", "A"])
    }

    @Test("recording an existing UDID de-duplicates and moves it to the front")
    func recordDeduplicates() {
        var recent = RecentDevices(udids: ["C", "B", "A"])
        recent.record("A")
        #expect(recent.udids == ["A", "C", "B"])
    }

    @Test("the list is capped at 3, oldest dropped")
    func capsAtThree() {
        var recent = RecentDevices()
        recent.record("A")
        recent.record("B")
        recent.record("C")
        recent.record("D")
        #expect(recent.udids == ["D", "C", "B"])
    }

    @Test("loading from persistence dedupes and caps at the boundary")
    func initEnforcesInvariants() {
        let recent = RecentDevices(udids: ["A", "B", "A", "C", "D"])
        #expect(recent.udids == ["A", "B", "C"])
    }

    @Test("Recent lists present, runtime-available devices in MRU order")
    func recentDevicesFilters() {
        let recent = RecentDevices(udids: ["C", "B", "A"])
        let available = [device("A"), device("C")]
        #expect(recent.resolved(among: available).map(\.udid) == ["C", "A"])
    }

    @Test("Recent drops runtime-missing devices")
    func recentDevicesSkipsRuntimeMissing() {
        let recent = RecentDevices(udids: ["B", "A"])
        let available = [device("A"), device("B", runtimeAvailable: false)]
        #expect(recent.resolved(among: available).map(\.udid) == ["A"])
    }

    @Test("preselection returns the most-recent still-available device")
    func preselectsMostRecentAvailable() {
        let recent = RecentDevices(udids: ["B", "A"])
        let available = [device("A"), device("B"), device("C")]
        #expect(recent.preferredDevice(among: available)?.udid == "B")
    }

    @Test("preselection falls back to the first runtime-available device when the MRU is empty")
    func preselectsFirstWhenEmpty() {
        let recent = RecentDevices()
        let available = [device("A", runtimeAvailable: false), device("B"), device("C")]
        #expect(recent.preferredDevice(among: available)?.udid == "B")
    }

    @Test("preselection falls back to the first available when the MRU's devices are gone")
    func preselectsFirstWhenRecentGone() {
        let recent = RecentDevices(udids: ["X", "Y"])
        let available = [device("A"), device("B")]
        #expect(recent.preferredDevice(among: available)?.udid == "A")
    }

    @Test("preselection never returns a runtime-missing recent device")
    func preselectsSkipsRuntimeMissingRecent() {
        let recent = RecentDevices(udids: ["A"])
        let available = [device("A", runtimeAvailable: false), device("B")]
        #expect(recent.preferredDevice(among: available)?.udid == "B")
    }
}
