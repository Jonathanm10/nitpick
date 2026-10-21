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

    /// The empty capture pane's line under "⌘S to capture".
    public var placeholderNote: String {
        self == .taken ? Self.takenExplanation : "or \(Self.chord) from the Simulator"
    }

    /// The topbar's warning while the chord is taken.
    public var takenWarning: String? {
        self == .taken ? "\(Self.chord) is taken by another app" : nil
    }

    public static let takenExplanation = "Another app holds \(chord), so capture from the Simulator is off. ⌘S still captures while nitpick is in front."
}
