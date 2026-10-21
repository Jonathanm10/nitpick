/// Whether the Review Session holds the global capture chord (ADR-0006), and
/// what the capture hints say about it.
public enum CaptureHotkeyState: Equatable, Sendable {
    /// No Review Session, so no chord.
    case inactive
    case registered
    /// Another app holds the chord, so only ⌘S captures.
    case taken

    public static let chord = "⌃⌥⌘N"

    /// The Capture button's keycap for the chord.
    public var chordKeycap: String? {
        self == .taken ? nil : Self.chord
    }

    public var captureHelp: String {
        self == .taken
            ? "Capture the current screen (⌘S)."
            : "Capture the current screen (⌘S here, \(Self.chord) from any app)."
    }

    /// The topbar's warning while the chord is taken.
    public var takenWarning: String? {
        self == .taken ? "\(Self.chord) is taken by another app" : nil
    }

    public static let takenExplanation = "Another app holds \(chord), so capture from the Simulator is off. ⌘S still captures while nitpick is in front."
}

/// The empty capture pane's prompt. A paused review captures nothing, so it
/// points at Resume review instead of promising a shortcut.
public struct CapturePlaceholder: Equatable, Sendable {
    public let title: String
    public let note: String?

    public init(isReviewing: Bool, hotkey: CaptureHotkeyState) {
        guard isReviewing else {
            title = "Resume review to capture"
            note = nil
            return
        }
        title = "⌘S to capture"
        note = hotkey == .taken ? CaptureHotkeyState.takenExplanation : "or \(CaptureHotkeyState.chord) from the Simulator"
    }
}

/// Why a capture cannot start. ⌘S and the Capture button are disabled while
/// one holds, so only the global chord meets it and needs it said.
public enum CaptureRefusal: Equatable, Sendable {
    case reviewPaused
    case busy
    case labelDraftPending

    /// Nil when a capture can start. A paused review comes first, since
    /// waiting out the other two would not help.
    public init?(isReviewing: Bool, isBusy: Bool, hasPendingLabelDraft: Bool) {
        if !isReviewing {
            self = .reviewPaused
        } else if isBusy {
            self = .busy
        } else if hasPendingLabelDraft {
            self = .labelDraftPending
        } else {
            return nil
        }
    }

    public var hotkeyMessage: String {
        switch self {
        case .reviewPaused:
            "\(CaptureHotkeyState.chord) captured nothing because the review is paused. Resume review, then capture again."
        case .busy:
            "\(CaptureHotkeyState.chord) captured nothing because nitpick was busy. Try again in a moment."
        case .labelDraftPending:
            "\(CaptureHotkeyState.chord) captured nothing because a text label is still open. Finish it, then capture again."
        }
    }
}
