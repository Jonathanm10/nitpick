import Foundation

/// What's missing on this Mac before a review can run (ADR-0002
/// consequence: simulators ship with full Xcode). Each case carries the
/// designer-facing story: a title naming the missing piece and the
/// install steps — what to install, where, what to click. Raw tool
/// errors never reach the designer.
public enum SetupGuidance: Equatable, Sendable {
    /// No active developer directory — Xcode isn't installed.
    case xcodeNotInstalled
    /// The active developer directory is the Command Line Tools (or some
    /// other non-Xcode path) — no simulators there.
    case commandLineToolsOnly(developerDirectory: String)
    /// A full Xcode is selected, but its simulator tools don't answer —
    /// first launch never finished, the license is unaccepted, or the
    /// selected Xcode is gone.
    case xcodeSetupIncomplete
    /// The tools work, but not one iOS simulator device has an installed
    /// runtime — typically a fresh Xcode whose iOS platform download was
    /// skipped.
    case missingIOSRuntime

    /// Names the missing piece.
    public var title: String {
        switch self {
        case .xcodeNotInstalled:
            return "Xcode isn't installed — nitpick needs its iOS simulator to run your Build."
        case .commandLineToolsOnly:
            return "This Mac has only the Command Line Tools — the iOS simulator ships with full Xcode."
        case .xcodeSetupIncomplete:
            return "Xcode is installed, but its simulator tools aren't working yet."
        case .missingIOSRuntime:
            return "No iOS simulator is ready to use — the iOS platform isn't installed."
        }
    }

    /// The install path, step by step.
    public var steps: [String] {
        switch self {
        case .xcodeNotInstalled:
            return [
                "Install Xcode from the Mac App Store (it's a large download).",
                "Open Xcode once and let it finish installing its components.",
            ]
        case .commandLineToolsOnly:
            return [
                "Install Xcode from the Mac App Store (it's a large download).",
                "Open Xcode once and let it finish installing its components.",
                "In Xcode's Settings → Locations, set “Command Line Tools” to the installed Xcode.",
            ]
        case .xcodeSetupIncomplete:
            return [
                "Open Xcode, accept the license if it asks, and let it finish installing its components.",
                "If Xcode was removed from this Mac, reinstall it from the Mac App Store.",
            ]
        case .missingIOSRuntime:
            return [
                "Open Xcode's Settings → Components.",
                "Download the iOS platform — that also creates the standard simulator devices.",
            ]
        }
    }
}

/// The outcome of the prerequisite probe: ready with the pickable devices,
/// or guidance for whatever is missing.
public enum SetupCheck: Equatable, Sendable {
    case ready([SimulatorDevice])
    case needsSetup(SetupGuidance)
}

extension AppCore {
    /// Probes this Mac's review prerequisites, cheapest first: an active
    /// developer directory that is a full Xcode, working simulator tools,
    /// and at least one iOS simulator device with an installed runtime.
    /// Run at launch and at session start, so a missing piece surfaces as
    /// guidance before any boot is attempted — never as an obscure
    /// mid-flow failure (ADR-0002).
    public func checkSetup() async throws -> SetupCheck {
        let printPath = SubprocessCommand(executablePath: "/usr/bin/xcode-select", arguments: ["-p"])
        let result = try await environment.subprocess.run(printPath)
        let developerDirectory = String(decoding: result.standardOutput, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.exitCode == 0, !developerDirectory.isEmpty else {
            return .needsSetup(.xcodeNotInstalled)
        }
        // A full Xcode's developer directory lives inside the app bundle
        // (…/Xcode.app/Contents/Developer); the Command Line Tools' does
        // not — and they ship no simulators.
        guard developerDirectory.hasSuffix(".app/Contents/Developer") else {
            return .needsSetup(.commandLineToolsOnly(developerDirectory: developerDirectory))
        }
        // From here on the tools themselves are the suspect: any simctl
        // failure is setup guidance, not a raw tool error in the UI.
        let devices: [SimulatorDevice]
        do {
            devices = try await simulatorDevices()
        } catch is SubprocessFailure {
            return .needsSetup(.xcodeSetupIncomplete)
        } catch SimulatorError.malformedDeviceList {
            return .needsSetup(.xcodeSetupIncomplete)
        }
        guard devices.contains(where: \.isRuntimeAvailable) else {
            return .needsSetup(.missingIOSRuntime)
        }
        return .ready(devices)
    }
}
