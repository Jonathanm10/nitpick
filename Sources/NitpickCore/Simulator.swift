import Foundation

/// A simulator device a Build can be reviewed on: the device half of a
/// Device Context.
public struct SimulatorDevice: Equatable, Sendable, Identifiable {
    public var udid: String
    public var name: String
    /// Human-readable OS, e.g. "iOS 26.4".
    public var osName: String
    public var isBooted: Bool
    /// False when CoreSimulator can't run this device — typically its OS
    /// runtime was deleted or never downloaded. Such a device is flagged
    /// at pick time and refused at launch, before any boot is attempted.
    public var isRuntimeAvailable: Bool

    public var id: String { udid }

    public init(udid: String, name: String, osName: String, isBooted: Bool, isRuntimeAvailable: Bool = true) {
        self.udid = udid
        self.name = name
        self.osName = osName
        self.isBooted = isBooted
        self.isRuntimeAvailable = isRuntimeAvailable
    }
}

/// Simulator interaction failed in a way that isn't a plain subprocess error.
public enum SimulatorError: Error, Equatable, LocalizedError {
    /// `simctl list` returned output the core cannot parse.
    case malformedDeviceList
    /// `simctl io screenshot` reported success but left no readable PNG.
    case captureUnreadable(path: String)
    /// `launch` was asked to boot a device whose OS runtime is missing.
    case runtimeUnavailable(deviceName: String, osName: String)
    /// `captureScreen` was asked for a device that is no longer booted —
    /// typically the designer closed the simulator mid-session.
    case deviceNotBooted(deviceName: String)

    public var errorDescription: String? {
        switch self {
        case .malformedDeviceList:
            return "The simulator device list could not be read. Is Xcode installed correctly?"
        case .captureUnreadable(let path):
            return "The capture succeeded but no image could be read at \(path)."
        case .runtimeUnavailable(let deviceName, let osName):
            return "\(deviceName) can't be booted: its \(osName) simulator runtime isn't installed."
        case .deviceNotBooted(let deviceName):
            return "\(deviceName) is not booted — the simulator may have been closed."
        }
    }
}

extension AppCore {
    /// The iOS simulator devices simctl knows, newest OS first, then by
    /// name. Non-iOS runtimes are dropped (ADR-0005); devices whose own
    /// runtime is missing stay in the list, flagged, so the picker can
    /// say why they can't be chosen.
    public func simulatorDevices() async throws -> [SimulatorDevice] {
        let list = SubprocessCommand(
            executablePath: "/usr/bin/xcrun",
            arguments: ["simctl", "list", "devices", "--json"]
        )
        let result = try await environment.subprocess.run(list)
        guard result.exitCode == 0 else {
            throw SubprocessFailure(
                command: list,
                exitCode: result.exitCode,
                standardError: String(decoding: result.standardError, as: UTF8.self)
            )
        }
        guard let deviceList = try? JSONDecoder().decode(SimctlDeviceList.self, from: result.standardOutput) else {
            throw SimulatorError.malformedDeviceList
        }

        return deviceList.devices
            .compactMap { runtimeIdentifier, devices -> (SimctlRuntime, [SimctlDeviceList.Device])? in
                guard let runtime = SimctlRuntime(runtimeIdentifier: runtimeIdentifier),
                      runtime.platform == "iOS"
                else { return nil }
                return (runtime, devices)
            }
            .sorted { lhs, rhs in
                lhs.0.version.lexicographicallyPrecedes(rhs.0.version) // oldest first…
            }
            .reversed() // …then flipped: newest OS first
            .flatMap { runtime, devices in
                devices
                    .sorted { $0.name < $1.name }
                    .map { device in
                        SimulatorDevice(
                            udid: device.udid,
                            name: device.name,
                            osName: runtime.osName,
                            isBooted: device.state == "Booted",
                            isRuntimeAvailable: device.isAvailable ?? true
                        )
                    }
            }
    }

    /// Boots the device, brings Simulator.app forward, installs the Build,
    /// and launches it (ADR-0002). nitpick owns this Build lifecycle only;
    /// it no longer touches the device's accessibility state (ADR-0009) —
    /// the designer sets that in the simulator and the core reads it back
    /// at capture time.
    public func launch(
        _ build: Build,
        on device: SimulatorDevice
    ) async throws {
        // The picker already flags such a device; refusing here keeps the
        // invariant even if a stale selection slips through — and fails
        // with the runtime story instead of an obscure boot error.
        guard device.isRuntimeAvailable else {
            throw SimulatorError.runtimeUnavailable(deviceName: device.name, osName: device.osName)
        }
        // Exit 149: "Unable to boot device in current state: Booted" — the
        // designer re-launching onto a booted device is normal, not a failure.
        try await runRequiringSuccess(
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "boot", device.udid]),
            allowedExitCodes: [0, 149]
        )
        // `simctl boot` returns while the device may still be booting;
        // bootstatus -b blocks until it is actually usable (and returns
        // immediately for an already-booted device).
        try await runRequiringSuccess(
            SubprocessCommand(executablePath: "/usr/bin/xcrun", arguments: ["simctl", "bootstatus", device.udid, "-b"])
        )
        try await runRequiringSuccess(
            SubprocessCommand(executablePath: "/usr/bin/open", arguments: ["-a", "Simulator"])
        )
        try await runRequiringSuccess(
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "install", device.udid, build.appBundleURL.path]
            )
        )
        try await runRequiringSuccess(
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "launch", device.udid, build.identity.bundleID]
            )
        )
    }

    /// Captures the device's current screen at native resolution via the
    /// simulator's own screenshot facility — no Screen Recording permission
    /// (ADR-0001). Returns PNG bytes.
    public func captureScreen(of device: SimulatorDevice) async throws -> Data {
        // `simctl io screenshot` does not fail on a device that isn't
        // booted — it waits for one, forever, which would hang the app
        // when the designer closes the simulator mid-session. Check the
        // live state first and throw the real story instead. Matched by
        // udid: `device` carries the state it had at launch time, not now.
        // (A shutdown racing in after this check could still hang — the
        // subprocess seam has no timeout; accepted, the window is tiny.)
        guard try await simulatorDevices().contains(where: { $0.udid == device.udid && $0.isBooted }) else {
            throw SimulatorError.deviceNotBooted(deviceName: device.name)
        }
        let capturesDirectory = workspaceDirectory.appendingPathComponent("captures", isDirectory: true)
        try FileManager.default.createDirectory(at: capturesDirectory, withIntermediateDirectories: true)
        let captureURL = capturesDirectory.appendingPathComponent("capture.png")

        try await runRequiringSuccess(
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "io", device.udid, "screenshot", "--type=png", captureURL.path]
            )
        )

        guard let png = try? Data(contentsOf: captureURL), !png.isEmpty else {
            throw SimulatorError.captureUnreadable(path: captureURL.path)
        }
        return png
    }

    /// Reads the simulator's live accessibility state — the settings half
    /// of a Device Context — for stamping onto a Finding at capture time
    /// (ADR-0009). Each `simctl ui <device> <option>` invoked with no value
    /// prints the option's current value; the reads run for content_size,
    /// appearance, and increase_contrast. A read that comes back
    /// `unsupported`, `unknown`, or otherwise unparseable maps to that
    /// dimension's default — the Accessibility line then simply omits it,
    /// never carrying a raw token.
    public func observedSettings(of device: SimulatorDevice) async throws -> DeviceSettings {
        let contentSize = try await readUISetting("content_size", of: device)
        let appearance = try await readUISetting("appearance", of: device)
        let increaseContrast = try await readUISetting("increase_contrast", of: device)
        return DeviceSettings(
            dynamicTypeSize: DeviceSettings.DynamicTypeSize(rawValue: contentSize) ?? .default,
            appearance: DeviceSettings.Appearance(rawValue: appearance) ?? .default,
            increaseContrast: increaseContrast == "enabled"
        )
    }

    /// Reads one `simctl ui` option's current value, trimmed of the
    /// trailing newline simctl prints. A non-zero exit is a real subprocess
    /// failure and throws; an unreadable value is left to the caller to map
    /// to a default.
    private func readUISetting(_ option: String, of device: SimulatorDevice) async throws -> String {
        let result = try await runRequiringSuccess(
            SubprocessCommand(
                executablePath: "/usr/bin/xcrun",
                arguments: ["simctl", "ui", device.udid, option]
            )
        )
        return String(decoding: result.standardOutput, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Runs a command through the subprocess seam and turns a disallowed
    /// exit code into a `SubprocessFailure` carrying the command and stderr.
    @discardableResult
    func runRequiringSuccess(
        _ command: SubprocessCommand,
        allowedExitCodes: Set<Int32> = [0]
    ) async throws -> SubprocessResult {
        let result = try await environment.subprocess.run(command)
        guard allowedExitCodes.contains(result.exitCode) else {
            throw SubprocessFailure(
                command: command,
                exitCode: result.exitCode,
                standardError: String(decoding: result.standardError, as: UTF8.self)
            )
        }
        return result
    }
}

/// The subset of `simctl list devices --json` the core reads.
private struct SimctlDeviceList: Decodable {
    var devices: [String: [Device]]

    struct Device: Decodable {
        var udid: String
        var name: String
        var state: String
        var isAvailable: Bool?
    }
}

/// A parsed CoreSimulator runtime identifier,
/// e.g. `com.apple.CoreSimulator.SimRuntime.iOS-26-4`.
private struct SimctlRuntime {
    var platform: String
    var version: [Int]
    var osName: String

    init?(runtimeIdentifier: String) {
        let prefix = "com.apple.CoreSimulator.SimRuntime."
        guard runtimeIdentifier.hasPrefix(prefix) else { return nil }
        let parts = runtimeIdentifier.dropFirst(prefix.count).split(separator: "-")
        guard parts.count >= 2 else { return nil }
        let version = parts.dropFirst().compactMap { Int($0) }
        guard version.count == parts.count - 1 else { return nil }
        self.platform = String(parts[0])
        self.version = version
        self.osName = "\(parts[0]) \(parts.dropFirst().joined(separator: "."))"
    }
}
