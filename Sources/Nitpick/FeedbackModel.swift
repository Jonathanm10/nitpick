import AppKit
import Foundation
import NitpickCore
import Observation

/// One presentation of the Feedback sheet: created when the sheet opens,
/// dropped when it closes, so every presentation starts blank.
@MainActor
@Observable
final class FeedbackModel: Identifiable {
    enum Phase: Equatable {
        case editing
        case sending
        case sent(SentFeedback)
        case failed(message: String)
    }

    private let core: AppCore
    let environment: Feedback.Environment
    var phase: Phase = .editing
    var kind: FeedbackKind = .bug
    var title = ""
    var description = ""
    private(set) var windowImagePNG: Data?
    private(set) var windowImage: NSImage?
    var attachesWindowImage: Bool { windowImagePNG != nil }
    var discardConfirmationRequested = false

    init(core: AppCore, environment: Feedback.Environment) {
        self.core = core
        self.environment = environment
    }

    var isFormEditable: Bool {
        switch phase {
        case .editing, .failed: true
        case .sending, .sent: false
        }
    }

    var canSend: Bool {
        isFormEditable && !payload.summary.isEmpty
    }

    var closeNeedsConfirmation: Bool {
        isFormEditable && payload.hasText
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

    func setWindowImage(_ png: Data?) {
        windowImagePNG = png
        windowImage = png.flatMap(NSImage.init(data:))
    }

    func setAttachesWindowImage(_ attaches: Bool) {
        setWindowImage(attaches ? WindowImageRenderer.mainWindowPNG() : nil)
    }

    /// Not routed through `AppModel.perform`: a Feedback must not flip
    /// `isBusy` and freeze the review behind the sheet.
    func send() async {
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
