import AppKit
import Foundation
import NitpickCore
import Observation

@MainActor
@Observable
final class FeedbackModel {
    enum Phase: Equatable {
        case notConnected
        case editing
        case sending
        case sent(SentFeedback)
        case failed(message: String)
    }

    var phase: Phase = .editing
    var kind: FeedbackKind = .bug
    var title = ""
    var description = ""
    private(set) var windowImagePNG: Data?
    private(set) var windowImage: NSImage?
    var attachesWindowImage: Bool { windowImagePNG != nil }
    var environment = Feedback.Environment(nitpick: "unknown", macOS: "unknown", xcode: "unknown")
    var discardConfirmationRequested = false

    var isFormEditable: Bool {
        switch phase {
        case .editing, .failed: true
        case .notConnected, .sending, .sent: false
        }
    }

    var canSend: Bool {
        isFormEditable && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var hasText: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var closeNeedsConfirmation: Bool {
        isFormEditable && hasText
    }

    var failureMessage: String? {
        if case .failed(let message) = phase { return message }
        return nil
    }

    var payload: Feedback {
        Feedback(
            kind: kind,
            title: title,
            description: description,
            environment: environment,
            imagePNG: windowImagePNG
        )
    }

    func reset(connected: Bool, environment: Feedback.Environment) {
        phase = connected ? .editing : .notConnected
        kind = .bug
        title = ""
        description = ""
        windowImagePNG = nil
        windowImage = nil
        self.environment = environment
        discardConfirmationRequested = false
    }

    func setWindowImage(_ png: Data?) {
        windowImagePNG = png
        windowImage = png.flatMap(NSImage.init(data:))
    }

    func setAttachesWindowImage(_ attaches: Bool) {
        setWindowImage(attaches ? WindowImageRenderer.mainWindowPNG() : nil)
    }

    /// Not routed through `AppModel.perform`: a Feedback must not flip
    /// `isBusy` and freeze the review behind the sheet.
    func send(using core: AppCore) async {
        guard canSend else { return }
        let payload = payload
        phase = .sending
        do {
            phase = .sent(try await core.send(payload))
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }
}
