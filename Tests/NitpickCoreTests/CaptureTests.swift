import Foundation
import NitpickCore
import Synchronization
import Testing

@Suite("Capturing the simulator screen")
struct CaptureTests {
    let workspace: URL
    let runner = FakeSubprocessRunner()
    let core: AppCore
    let device = SimulatorDevice(udid: "AAAA-1111", name: "iPhone 17 Pro", osName: "iOS 26.4", isBooted: true)
    let pngBytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01, 0x02, 0x03])

    init() throws {
        workspace = try Fixtures.makeTemporaryDirectory()
            .appendingPathComponent("workspace", isDirectory: true)
        core = AppCore(environment: .fake(subprocess: runner), workspaceDirectory: workspace)
    }

    private var capturePath: URL {
        workspace.appendingPathComponent("captures/capture.png")
    }

    /// Scripts the capture preflight's device-list check: the device
    /// reports the given state, whatever stale `isBooted` the passed-in
    /// `SimulatorDevice` still carries.
    private func enqueueDeviceList(state: String) {
        runner.enqueue(SubprocessResult(
            exitCode: 0,
            standardOutput: Data(Fixtures.deviceListJSON(udid: device.udid, name: device.name, state: state).utf8)
        ))
    }

    private func enqueueSettingsReads(failing failed: Set<String> = []) {
        for (option, value) in [("content_size", "accessibility-large"), ("appearance", "dark"), ("increase_contrast", "enabled")] {
            runner.enqueue(
                failed.contains(option)
                    ? SubprocessResult(exitCode: 1, standardError: Data("\(option) failed".utf8))
                    : SubprocessResult(exitCode: 0, standardOutput: Data("\(value)\n".utf8)),
                for: .uiRead(option, of: device)
            )
        }
    }

    private func enqueueScreenshot(exitCode: Int32 = 0, writing png: Data?) {
        let path = capturePath
        runner.enqueue(
            SubprocessResult(exitCode: exitCode, standardError: Data((exitCode == 0 ? "" : "No devices are booted.").utf8)),
            for: .screenshot(device, to: path)
        ) { _ in
            try png?.write(to: path)
        }
    }

    @Test("a capture checks the device is booted, then takes the screenshot and reads the accessibility state")
    func capture() async throws {
        enqueueDeviceList(state: "Booted")
        enqueueScreenshot(writing: pngBytes)
        enqueueSettingsReads()

        let captured = try await core.captureScreen(of: device)

        runner.expectExecuted(inSteps: [
            [.deviceList],
            [.screenshot(device, to: capturePath)] + SubprocessCommand.settingsReads(of: device),
        ])
        #expect(captured == ScreenCapture(
            screenshotPNG: pngBytes,
            settings: DeviceSettings(dynamicTypeSize: .accessibilityLarge, appearance: .dark, increaseContrast: true)
        ))
    }

    @Test("the screenshot and the three settings reads are all in flight at once")
    func screenshotAndSettingsOverlap() async throws {
        let overlapping = OverlapRunner(
            gated: Set([.screenshot(device, to: capturePath)] + SubprocessCommand.settingsReads(of: device)),
            deviceList: Data(Fixtures.deviceListJSON(udid: device.udid, name: device.name, state: "Booted").utf8),
            png: pngBytes
        )
        let core = AppCore(environment: .fake(subprocess: overlapping), workspaceDirectory: workspace)

        let captured = try await core.captureScreen(of: device)

        #expect(captured.screenshotPNG == pngBytes)
        #expect(overlapping.maxInFlight == 4)
        #expect(overlapping.started.first == .deviceList)
    }

    @Test("a screenshot failure surfaces as the screenshot's subprocess failure, even when a settings read fails too")
    func screenshotFailure() async throws {
        enqueueDeviceList(state: "Booted")
        enqueueScreenshot(exitCode: 1, writing: nil)
        enqueueSettingsReads(failing: ["content_size"])

        await #expect(throws: SubprocessFailure(
            command: .screenshot(device, to: capturePath),
            exitCode: 1,
            standardError: "No devices are booted."
        )) {
            try await core.captureScreen(of: device)
        }
    }

    @Test("a failed settings read surfaces as that read's failure, the first in content_size, appearance, increase_contrast order")
    func settingsFailure() async throws {
        enqueueDeviceList(state: "Booted")
        enqueueScreenshot(writing: pngBytes)
        enqueueSettingsReads(failing: ["appearance", "increase_contrast"])

        await #expect(throws: SubprocessFailure(
            command: .uiRead("appearance", of: device),
            exitCode: 1,
            standardError: "appearance failed"
        )) {
            try await core.captureScreen(of: device)
        }
    }

    @Test("a screenshot that reports success but writes nothing is a clear error")
    func missingCaptureFile() async throws {
        enqueueDeviceList(state: "Booted")
        enqueueScreenshot(writing: nil)
        enqueueSettingsReads()

        await #expect(throws: SimulatorError.captureUnreadable(path: capturePath.path)) {
            try await core.captureScreen(of: device)
        }
    }

    @Test("a device that is no longer booted refuses fast — the screenshot command that would hang never runs")
    func captureOnShutdownDevice() async throws {
        enqueueDeviceList(state: "Shutdown")

        await #expect(throws: SimulatorError.deviceNotBooted(deviceName: "iPhone 17 Pro")) {
            try await core.captureScreen(of: device)
        }

        // The guard, not the message, is the fix: `simctl io screenshot`
        // waits forever for a booted device, so it must never be reached,
        // and neither is any settings read.
        #expect(runner.executedCommands == [.deviceList])
    }
}

/// Holds each gated command until every gated command has started (or a
/// second passes), recording how many ran at once. Serial code would
/// reach a peak of 1.
private final class OverlapRunner: SubprocessRunner {
    private struct State {
        var started: [SubprocessCommand] = []
        var inFlight = 0
        var maxInFlight = 0
    }

    private let gated: Set<SubprocessCommand>
    private let deviceList: Data
    private let png: Data
    private let state = Mutex(State())

    init(gated: Set<SubprocessCommand>, deviceList: Data, png: Data) {
        self.gated = gated
        self.deviceList = deviceList
        self.png = png
    }

    var maxInFlight: Int { state.withLock { $0.maxInFlight } }
    var started: [SubprocessCommand] { state.withLock { $0.started } }

    func run(_ command: SubprocessCommand) async throws -> SubprocessResult {
        state.withLock { $0.started.append(command) }
        guard gated.contains(command) else {
            return SubprocessResult(exitCode: 0, standardOutput: deviceList)
        }
        state.withLock {
            $0.inFlight += 1
            $0.maxInFlight = max($0.maxInFlight, $0.inFlight)
        }
        let deadline = ContinuousClock.now + .seconds(1)
        while maxInFlight < gated.count, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        state.withLock { $0.inFlight -= 1 }
        if command.arguments.contains("screenshot"), let path = command.arguments.last {
            try png.write(to: URL(fileURLWithPath: path))
            return SubprocessResult(exitCode: 0)
        }
        return SubprocessResult(exitCode: 0, standardOutput: Data("large\n".utf8))
    }
}
