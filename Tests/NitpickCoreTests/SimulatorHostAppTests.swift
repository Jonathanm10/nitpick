import Foundation
import NitpickCore
import Testing

@Suite("Simulator host app discovery")
struct SimulatorHostAppTests {
    let temp: URL

    init() throws {
        temp = try Fixtures.makeTemporaryDirectory()
    }

    @Test("Xcode 26 layout: Simulator.app under Developer/Applications")
    func discoversSimulator() throws {
        let xcode = try Fixtures.writeXcode(in: temp.appendingPathComponent("xcode26"), hostApp: .simulator)
        let host = SimulatorHostApp.discover(inDeveloperDirectory: xcode.developerDirectory)

        #expect(host?.bundleIdentifier == "com.apple.iphonesimulator")
        #expect(host?.displayName == "Simulator")
        #expect(host?.bundleURL.path == xcode.hostAppURL?.path)
    }

    @Test("Xcode 27 layout: DeviceHub.app under Contents/Applications")
    func discoversDeviceHub() throws {
        let xcode = try Fixtures.writeXcode(in: temp.appendingPathComponent("xcode27"), hostApp: .deviceHub)
        let host = SimulatorHostApp.discover(inDeveloperDirectory: xcode.developerDirectory)

        #expect(host?.bundleIdentifier == "com.apple.dt.Devices")
        #expect(host?.displayName == "DeviceHub")
        #expect(host?.bundleURL.path == xcode.hostAppURL?.path)
    }

    @Test("neither host app: discover returns nil")
    func discoversNeither() throws {
        let xcode = try Fixtures.writeXcode(in: temp.appendingPathComponent("no-host"), hostApp: .none)
        #expect(SimulatorHostApp.discover(inDeveloperDirectory: xcode.developerDirectory) == nil)
    }

    @Test("when both host apps exist, DeviceHub wins")
    func prefersDeviceHubWhenBothExist() throws {
        let xcode = try Fixtures.writeXcode(in: temp.appendingPathComponent("both"), hostApp: .deviceHub)
        try Fixtures.writeMacAppBundle(
            named: "Simulator.app",
            in: xcode.developerDirectory.appendingPathComponent("Applications", isDirectory: true),
            infoPlist: [
                "CFBundleIdentifier": "com.apple.iphonesimulator",
                "CFBundleDisplayName": "Simulator",
            ]
        )

        let host = SimulatorHostApp.discover(inDeveloperDirectory: xcode.developerDirectory)
        #expect(host?.bundleIdentifier == "com.apple.dt.Devices")
        #expect(host?.bundleURL.path == xcode.hostAppURL?.path)
    }

    @Test("display name prefers CFBundleDisplayName, then CFBundleName, then the .app file name")
    func displayNameFallback() throws {
        let developer = temp.appendingPathComponent("names/Xcode.app/Contents/Developer", isDirectory: true)
        let applications = developer.appendingPathComponent("Applications", isDirectory: true)

        try Fixtures.writeMacAppBundle(
            named: "Simulator.app",
            in: applications,
            infoPlist: ["CFBundleIdentifier": "com.apple.iphonesimulator"]
        )
        #expect(
            SimulatorHostApp.discover(inDeveloperDirectory: developer)?.displayName == "Simulator"
        )

        try FileManager.default.removeItem(at: applications)
        try Fixtures.writeMacAppBundle(
            named: "Simulator.app",
            in: applications,
            infoPlist: [
                "CFBundleIdentifier": "com.apple.iphonesimulator",
                "CFBundleName": "FromName",
            ]
        )
        #expect(
            SimulatorHostApp.discover(inDeveloperDirectory: developer)?.displayName == "FromName"
        )

        try FileManager.default.removeItem(at: applications)
        try Fixtures.writeMacAppBundle(
            named: "Simulator.app",
            in: applications,
            infoPlist: [
                "CFBundleIdentifier": "com.apple.iphonesimulator",
                "CFBundleName": "FromName",
                "CFBundleDisplayName": "FromDisplay",
            ]
        )
        #expect(
            SimulatorHostApp.discover(inDeveloperDirectory: developer)?.displayName == "FromDisplay"
        )
    }

    @Test("discovers the real DeviceHub.app under this Mac's Xcode when present")
    func discoversLiveDeviceHubWhenPresent() throws {
        let developer = URL(fileURLWithPath: "/Applications/Xcode.app/Contents/Developer", isDirectory: true)
        let deviceHub = URL(
            fileURLWithPath: "/Applications/Xcode.app/Contents/Applications/DeviceHub.app",
            isDirectory: true
        )
        guard FileManager.default.fileExists(atPath: deviceHub.path) else { return }

        let host = try #require(SimulatorHostApp.discover(inDeveloperDirectory: developer))
        #expect(host.bundleIdentifier == "com.apple.dt.Devices")
        #expect(host.bundleURL.path == deviceHub.path)
    }

    @Test("ignores an iOS-style root Info.plist — host apps use Contents/Info.plist")
    func ignoresRootLevelPlist() throws {
        let developer = temp.appendingPathComponent(
            "flat/Xcode.app/Contents/Developer", isDirectory: true
        )
        let applications = developer.deletingLastPathComponent()
            .appendingPathComponent("Applications", isDirectory: true)
        try Fixtures.writeAppBundle(
            named: "DeviceHub.app",
            in: applications,
            infoPlist: [
                "CFBundleIdentifier": "com.apple.dt.Devices",
                "CFBundleDisplayName": "DeviceHub",
            ]
        )
        #expect(SimulatorHostApp.discover(inDeveloperDirectory: developer) == nil)
    }
}
