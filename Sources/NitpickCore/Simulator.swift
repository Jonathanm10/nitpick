import Foundation

/// A simulator device a Build can be reviewed on: the device half of a
/// Device Context.
public struct SimulatorDevice: Equatable, Sendable, Identifiable {
    public var udid: String
    public var name: String
    /// Human-readable OS, e.g. "iOS 26.4".
    public var osName: String
    public var isBooted: Bool

    public var id: String { udid }

    public init(udid: String, name: String, osName: String, isBooted: Bool) {
        self.udid = udid
        self.name = name
        self.osName = osName
        self.isBooted = isBooted
    }
}

/// Simulator interaction failed in a way that isn't a plain subprocess error.
public enum SimulatorError: Error, Equatable, LocalizedError {
    /// `simctl list` returned output the core cannot parse.
    case malformedDeviceList
    /// `simctl io screenshot` reported success but left no readable PNG.
    case captureUnreadable(path: String)

    public var errorDescription: String? {
        switch self {
        case .malformedDeviceList:
            return "The simulator device list could not be read. Is Xcode installed correctly?"
        case .captureUnreadable(let path):
            return "The capture succeeded but no image could be read at \(path)."
        }
    }
}

extension AppCore {
    /// The available iOS simulator devices, newest OS first, then by name.
    /// Non-iOS runtimes are dropped (ADR-0005).
    public func simulatorDevices() async throws -> [SimulatorDevice] {
        let list = SubprocessCommand(
            executablePath: "/usr/bin/xcrun",
            arguments: ["simctl", "list", "devices", "available", "--json"]
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
                    .filter { $0.isAvailable ?? true }
                    .sorted { $0.name < $1.name }
                    .map { device in
                        SimulatorDevice(
                            udid: device.udid,
                            name: device.name,
                            osName: runtime.osName,
                            isBooted: device.state == "Booted"
                        )
                    }
            }
    }

    /// Boots the device, brings Simulator.app forward, installs the Build,
    /// and launches it (ADR-0002).
    public func launch(_ build: Build, on device: SimulatorDevice) async throws {
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
