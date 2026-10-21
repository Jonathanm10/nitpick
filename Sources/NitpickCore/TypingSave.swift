import Foundation

/// When the shell's session lands on disk. A save writes the whole
/// session, so a keystroke defers it until typing pauses for
/// `quietPeriod`, but never past `maximumDelay` after the first unsaved
/// keystroke: steady typing still saves, and a crash loses at most
/// `maximumDelay` of it. A failed save stays pending and retries within
/// `maximumDelay`, so a transient write error never drops what the
/// designer typed.
public struct TypingSave: Equatable, Sendable {
    public static let quietPeriod = Duration.milliseconds(500)
    public static let maximumDelay = Duration.seconds(2)

    private var unsavedSince: ContinuousClock.Instant?

    public init() {}

    public var isPending: Bool { unsavedSince != nil }

    /// Whether a flush point writes now. Never while filing: the run saves
    /// its own copy of the session, typed text included, after every step,
    /// and a shell write could replace a newer step with an older session.
    public func flushes(during activity: ShellActivity) -> Bool {
        isPending && !activity.isFiling
    }

    /// Records a keystroke at `now` and returns when the save is due.
    public mutating func keystroke(at now: ContinuousClock.Instant) -> ContinuousClock.Instant {
        let first = unsavedSince ?? now
        unsavedSince = first
        return min(now + Self.quietPeriod, first + Self.maximumDelay)
    }

    public mutating func saved() {
        unsavedSince = nil
    }

    /// Records a save that failed at `now` and returns when to retry.
    public mutating func failed(at now: ContinuousClock.Instant) -> ContinuousClock.Instant {
        unsavedSince = now
        return now + Self.maximumDelay
    }
}
