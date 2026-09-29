import AppKit
import Foundation
import NitpickCore
import Observation

/// The Feedback sheet's state (glossary: Feedback): what the designer typed,
/// the read-only Environment, the optional window image, and where the
/// send stands. `AppModel` forwards the menu and hands in the core and the
/// review context as values; nothing here touches the Review Session or
/// History.
@MainActor
@Observable
final class FeedbackModel {
    enum Phase: Equatable {
        /// No YouTrack connection: the sheet points at Settings instead of
        /// offering a form it could never send (the menu item is never
        /// disabled, so this state is the explanation).
        case notConnected
        case editing
        case sending
        case sent(SentFeedback)
        /// The send failed; the form stays with every field intact so a
        /// retry costs one click.
        case failed(message: String)
    }

    var phase: Phase = .editing
    var kind: FeedbackKind = .bug
    var title = ""
    var description = ""
    /// The PNG rendered when the toggle turned on — the exact bytes the
    /// preview shows and the send uploads.
    private(set) var windowImagePNG: Data?
    private(set) var windowImage: NSImage?
    /// Off by default (PRD story 6): an image of the designer's window
    /// leaves the machine only when they opt in and have seen it. Derived,
    /// so the toggle and the bytes can never disagree.
    var attachesWindowImage: Bool { windowImagePNG != nil }
    /// Gathered at presentation; shown read-only and sent as the Issue's
    /// Environment section. Never carries the token or the instance URL.
    var environment = Feedback.Environment(nitpick: "unknown", macOS: "unknown", xcode: "unknown")
    /// Staged by Cancel/Escape when the sheet holds text.
    var discardConfirmationRequested = false

    /// The form is live while editing and after a failure; sending freezes
    /// it so the text sent is the text shown.
    var isFormEditable: Bool {
        switch phase {
        case .editing, .failed: true
        case .notConnected, .sending, .sent: false
        }
    }

    /// Send is offered only with a non-blank title — the core refuses one
    /// anyway, but an enabled button that always fails would be a lie.
    var canSend: Bool {
        isFormEditable && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Whether closing would lose something the designer wrote. Whitespace
    /// alone is not worth a confirmation.
    var hasText: Bool {
        !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Closing asks first only while unsent text is on screen: a sent
    /// Feedback already lives in YouTrack, and a not-connected sheet holds
    /// nothing.
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

    /// A fresh sheet: no draft survives a close (PRD R3 Q1, no draft
    /// persistence).
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

    /// Turning the toggle on stores the rendered image with it; turning it
    /// off drops the image so nothing stale can ride along later.
    func setWindowImage(_ png: Data?) {
        windowImagePNG = png
        windowImage = png.flatMap(NSImage.init(data:))
    }

    /// The Attach window image toggle. On draws the main window's content
    /// view into a bitmap in-process (`cacheDisplay`) — never the screen, so
    /// no Screen Recording permission or prompt is ever involved. The sheet
    /// is its own window and the title bar sits outside the content view,
    /// so both are absent from the image by design (PRD R2 Q5).
    func setAttachesWindowImage(_ attaches: Bool) {
        setWindowImage(attaches ? WindowImageRenderer.mainWindowPNG() : nil)
    }

    /// Sends the sheet's Feedback as one Issue in `NIT`. Deliberately not
    /// routed through `AppModel.perform`: Feedback must not flip `isBusy`
    /// and freeze the review behind the sheet, and its error belongs in the
    /// sheet, not on home. A failure keeps every field for the retry; once
    /// the Issue exists the core reports partial failures as warnings on
    /// the sent state instead, so a retry never files a duplicate.
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
