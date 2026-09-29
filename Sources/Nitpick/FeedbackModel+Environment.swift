import Foundation
import NitpickCore

extension FeedbackModel {
    static func environment(core: AppCore, review: Feedback.Environment.ReviewContext?) async -> Feedback.Environment {
        let info = Bundle.main.infoDictionary
        return Feedback.Environment(
            nitpickVersion: info?["CFBundleShortVersionString"] as? String,
            nitpickBuild: info?["CFBundleVersion"] as? String,
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            xcode: await core.xcodeVersion(),
            review: review
        )
    }
}
