import Foundation
import NitpickCore

extension FeedbackModel {
    /// What the open Review Session contributes to a Feedback's Environment
    /// section, handed in by `AppModel` as a value so the Feedback code
    /// never reads session state. Nil while no Review Session is open.
    struct ReviewContext: Sendable {
        var build: BuildIdentity
        var host: SimulatorHostApp?
        var device: SimulatorDevice?
    }

    /// The Environment section, gathered at presentation. Values only —
    /// never the token or the instance URL. Build and Capture Source only
    /// while a Review Session is open, so the team can reproduce what the
    /// designer saw. Missing versions are spelled "unknown" here; the core
    /// sends them verbatim.
    static func environment(core: AppCore, review: ReviewContext?) async -> Feedback.Environment {
        Feedback.Environment(
            nitpick: nitpickVersion,
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            xcode: await core.xcodeVersion() ?? "unknown",
            build: review.map { "\($0.build.bundleID) \($0.build.version) (\($0.build.buildNumber))" },
            captureSource: review.map(captureSourceName)
        )
    }

    /// `<version> (<build>)` from the app bundle's Info.plist; "unknown"
    /// under `swift run`, where there is no bundle to read.
    static var nitpickVersion: String {
        let info = Bundle.main.infoDictionary
        guard let version = info?["CFBundleShortVersionString"] as? String, !version.isEmpty,
              let build = info?["CFBundleVersion"] as? String, !build.isEmpty
        else { return "unknown" }
        return "\(version) (\(build))"
    }

    /// Where captures come from right now (glossary: Capture Source): the
    /// simulator host app and the device the Build runs on, or the plain
    /// simulator before Resume review has launched it.
    static func captureSourceName(_ review: ReviewContext) -> String {
        guard let device = review.device else { return "Simulator (not running)" }
        return "\(review.host?.displayName ?? "Simulator") — \(device.name), \(device.osName)"
    }
}
