import Foundation
import NitpickCore
import Testing

/// Xcode and runtime detection with guided setup (issue 10, ADR-0002
/// consequence): missing prerequisites become a guidance state through the
/// app core API — never a raw tool error — and a device whose runtime is
/// missing is refused before any boot is attempted.
@Suite("Setup guidance")
struct SetupGuidanceTests {
    let runner = FakeSubprocessRunner()
    let core: AppCore
    let build: Build

    init() throws {
        let temp = try Fixtures.makeTemporaryDirectory()
        core = AppCore(
            environment: .fake(subprocess: runner),
            workspaceDirectory: temp.appendingPathComponent("workspace", isDirectory: true)
        )
        let appURL = try Fixtures.writeAppBundle(
            named: "ReviewMe.app", in: temp, infoPlist: Fixtures.simulatorInfoPlist()
        )
        build = Build(
            identity: BuildIdentity(bundleID: "ch.liip.reviewme", version: "2.1.0", buildNumber: "421"),
            appBundleURL: appURL
        )
    }

    // MARK: - checkSetup: the launch/session-start prerequisite probe

    @Test("no active developer directory: guidance names Xcode and the Mac App Store, nothing else is probed")
    func xcodeNotInstalled() async throws {
        runner.enqueue(SubprocessResult(
            exitCode: 2,
            standardError: Data("xcode-select: error: unable to get active developer directory".utf8)
        ))

        let check = try await core.checkSetup()

        #expect(runner.executedCommands == [
            SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"])
        ])
        guard case .needsSetup(let guidance) = check else {
            Issue.record("expected setup guidance, got \(check)")
            return
        }
        #expect(guidance == .xcodeNotInstalled)
        #expect(guidance.title.contains("Xcode"))
        #expect(guidance.steps.contains { $0.contains("Mac App Store") })
    }

    @Test("Command Line Tools selected instead of Xcode: guidance names the full-Xcode fix, simctl is never run")
    func commandLineToolsOnly() async throws {
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data("/Library/Developer/CommandLineTools\n".utf8)
        ))

        let check = try await core.checkSetup()

        #expect(runner.executedCommands == [
            SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"])
        ])
        guard case .needsSetup(let guidance) = check else {
            Issue.record("expected setup guidance, got \(check)")
            return
        }
        #expect(guidance == .commandLineToolsOnly(developerDirectory: "/Library/Developer/CommandLineTools"))
        #expect(guidance.title.contains("Command Line Tools"))
        #expect(guidance.steps.contains { $0.contains("Mac App Store") })
        #expect(guidance.steps.contains { $0.contains("Locations") })
    }

    @Test("Xcode selected but simctl broken: setup-incomplete guidance, the raw tool error never leaks")
    func xcodeSetupIncomplete() async throws {
        let rawToolError = "You have not agreed to the Xcode license agreements"
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data("/Applications/Xcode.app/Contents/Developer\n".utf8)
        ))
        runner.enqueue(SubprocessResult(exitCode: 69, standardError: Data(rawToolError.utf8)))

        let check = try await core.checkSetup()

        #expect(runner.executedCommands == [
            SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"]),
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "list", "devices", "--json"]
            ),
        ])
        guard case .needsSetup(let guidance) = check else {
            Issue.record("expected setup guidance, got \(check)")
            return
        }
        #expect(guidance == .xcodeSetupIncomplete)
        #expect(guidance.title.contains("Xcode"))
        #expect(guidance.steps.contains { $0.contains("components") })
        for text in [guidance.title] + guidance.steps {
            #expect(!text.contains(rawToolError))
        }
    }

    @Test("simctl healthy but no usable iOS device: guidance points at Xcode's Components download")
    func missingIOSRuntime() async throws {
        // A watchOS runtime and an iOS device whose runtime was deleted:
        // nothing a review could boot.
        let deviceListJSON = """
            {
              "devices" : {
                "com.apple.CoreSimulator.SimRuntime.watchOS-12-0" : [
                  { "udid" : "EEEE-5555", "name" : "Apple Watch Ultra 3", "state" : "Shutdown", "isAvailable" : true }
                ],
                "com.apple.CoreSimulator.SimRuntime.iOS-26-4" : [
                  {
                    "udid" : "BBBB-2222",
                    "name" : "Broken iPhone",
                    "state" : "Shutdown",
                    "isAvailable" : false,
                    "availabilityError" : "runtime profile not found"
                  }
                ]
              }
            }
            """
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data("/Applications/Xcode.app/Contents/Developer\n".utf8)
        ))
        runner.enqueue(SubprocessResult(exitCode: 0, standardOutput: Data(deviceListJSON.utf8)))

        let check = try await core.checkSetup()

        guard case .needsSetup(let guidance) = check else {
            Issue.record("expected setup guidance, got \(check)")
            return
        }
        #expect(guidance == .missingIOSRuntime)
        #expect(guidance.title.contains("iOS"))
        #expect(guidance.steps.contains { $0.contains("Components") })
    }

    @Test("prerequisites present: the check hands back the pickable devices and no guidance")
    func prerequisitesPresent() async throws {
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data("/Applications/Xcode.app/Contents/Developer\n".utf8)
        ))
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data(SimulatorDeviceTests.deviceListJSON.utf8)
        ))

        let check = try await core.checkSetup()

        #expect(runner.executedCommands == [
            SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"]),
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "list", "devices", "--json"]
            ),
        ])
        guard case .ready(let devices) = check else {
            Issue.record("expected a ready check, got \(check)")
            return
        }
        // The runtime-missing device stays in the list, flagged — the
        // pick-time story — while the check stays guidance-free.
        #expect(devices.map(\.name) == ["iPad (A16)", "iPhone Air", "Broken iPhone", "iPhone 17 Pro"])
        #expect(devices.map(\.isRuntimeAvailable) == [true, true, false, true])
    }

    @Test("a runtime-missing device is refused at launch, before any boot is attempted")
    func launchRefusesRuntimeMissingDevice() async throws {
        let device = SimulatorDevice(
            udid: "BBBB-2222", name: "Broken iPhone", osName: "iOS 26.4", isBooted: false,
            isRuntimeAvailable: false
        )

        await #expect(throws: SimulatorError.runtimeUnavailable(deviceName: "Broken iPhone", osName: "iOS 26.4")) {
            try await core.launch(build, on: device)
        }
        #expect(runner.executedCommands.isEmpty)
    }
}
