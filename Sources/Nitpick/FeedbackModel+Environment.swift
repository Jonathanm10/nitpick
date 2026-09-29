import Foundation
import NitpickCore

extension FeedbackModel {
    struct ReviewContext: Sendable {
        var build: BuildIdentity
        var host: SimulatorHostApp?
        var device: SimulatorDevice?
    }

    static func environment(core: AppCore, review: ReviewContext?) async -> Feedback.Environment {
        Feedback.Environment(
            nitpick: nitpickVersion,
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            xcode: await core.xcodeVersion() ?? "unknown",
            build: review.map { "\($0.build.bundleID) \($0.build.version) (\($0.build.buildNumber))" },
            captureSource: review.map(captureSourceName)
        )
    }

    static var nitpickVersion: String {
        let info = Bundle.main.infoDictionary
        guard let version = info?["CFBundleShortVersionString"] as? String, !version.isEmpty,
              let build = info?["CFBundleVersion"] as? String, !build.isEmpty
        else { return "unknown" }
        return "\(version) (\(build))"
    }

    static func captureSourceName(_ review: ReviewContext) -> String {
        guard let device = review.device else { return "Simulator (not running)" }
        return "\(review.host?.displayName ?? "Simulator") — \(device.name), \(device.osName)"
    }
}
