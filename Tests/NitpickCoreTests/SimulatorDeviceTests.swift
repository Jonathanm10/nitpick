import Foundation
import NitpickCore
import Testing

@Suite("Simulator device listing")
struct SimulatorDeviceTests {
    let runner = FakeSubprocessRunner()
    let core: AppCore

    init() throws {
        core = AppCore(
            environment: .fake(subprocess: runner),
            workspaceDirectory: try Fixtures.makeTemporaryDirectory()
        )
    }

    static let deviceListJSON = """
        {
          "devices" : {
            "com.apple.CoreSimulator.SimRuntime.iOS-26-4" : [
              {
                "udid" : "AAAA-1111",
                "name" : "iPhone 17 Pro",
                "state" : "Shutdown",
                "isAvailable" : true,
                "deviceTypeIdentifier" : "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
                "dataPath" : "\\/tmp\\/x",
                "logPath" : "\\/tmp\\/y"
              },
              {
                "udid" : "BBBB-2222",
                "name" : "Broken iPhone",
                "state" : "Shutdown",
                "isAvailable" : false,
                "availabilityError" : "runtime profile not found"
              }
            ],
            "com.apple.CoreSimulator.SimRuntime.iOS-26-5" : [
              {
                "udid" : "CCCC-3333",
                "name" : "iPhone Air",
                "state" : "Booted",
                "isAvailable" : true
              },
              {
                "udid" : "DDDD-4444",
                "name" : "iPad (A16)",
                "state" : "Shutdown",
                "isAvailable" : true
              }
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-12-0" : [
              {
                "udid" : "EEEE-5555",
                "name" : "Apple Watch Ultra 3",
                "state" : "Shutdown",
                "isAvailable" : true
              }
            ]
          }
        }
        """

    @Test("available iOS devices are listed newest OS first, watchOS and unavailable devices dropped")
    func listsDevices() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data(Self.deviceListJSON.utf8)))

        let devices = try await core.simulatorDevices()

        #expect(runner.executedCommands == [
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "list", "devices", "available", "--json"]
            )
        ])
        #expect(devices == [
            SimulatorDevice(udid: "DDDD-4444", name: "iPad (A16)", osName: "iOS 26.5", isBooted: false),
            SimulatorDevice(udid: "CCCC-3333", name: "iPhone Air", osName: "iOS 26.5", isBooted: true),
            SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: false),
        ])
    }

    @Test("a simctl failure surfaces as a subprocess failure")
    func simctlFailure() async throws {
        runner.enqueue(SubprocessResult(exitCode: 1, standardError: Data("simctl: no developer dir".utf8)))

        await #expect(throws: SubprocessFailure.self) {
            try await core.simulatorDevices()
        }
    }

    @Test("unparseable simctl output is a clear error")
    func malformedOutput() async throws {
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data("garbage".utf8)))

        await #expect(throws: SimulatorError.malformedDeviceList) {
            try await core.simulatorDevices()
        }
    }
}
