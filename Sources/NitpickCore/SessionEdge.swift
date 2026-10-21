import Foundation

/// A Review Session opening or closing: the one moment the shell's
/// per-session state starts over. Either edge closes the Editor and
/// forgets the last filing failure, so the next session never opens on a
/// stale "File N remaining". The two edges differ only in what Start review
/// set up before the session existed.
public enum SessionEdge: Equatable, Sendable {
    case opened
    case closed

    /// Nil while the session only changes in place, or stays closed.
    public init?(wasOpen: Bool, isOpen: Bool) {
        guard wasOpen != isOpen else { return nil }
        self = isOpen ? .opened : .closed
    }

    /// Start review launches the Build and reads the project's triage
    /// schema before it opens the session, so an open keeps both and only a
    /// close drops them.
    public var dropsRunAndSchema: Bool { self == .closed }

    /// A held filing result never shows beside a live session. File all
    /// holds its result only after its session has closed.
    public var dismissesFilingResult: Bool { self == .opened }
}
