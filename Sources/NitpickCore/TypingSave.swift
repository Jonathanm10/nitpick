import Foundation

/// When typed text lands on disk. A save writes the whole session, so a
/// keystroke defers it until typing pauses for `quietPeriod`, but never
/// past `maximumDelay` after the first unsaved keystroke: steady typing
/// still saves, and a crash loses at most `maximumDelay` of it. Any other
/// save lands the typed text too.
public struct TypingSave: Equatable, Sendable {
    public static let quietPeriod = Duration.milliseconds(500)
    public static let maximumDelay = Duration.seconds(2)

    private var firstUnsavedKeystroke: ContinuousClock.Instant?

    public init() {}

    public var isPending: Bool { firstUnsavedKeystroke != nil }

    /// Records a keystroke at `now` and returns when the save is due.
    public mutating func keystroke(at now: ContinuousClock.Instant) -> ContinuousClock.Instant {
        let first = firstUnsavedKeystroke ?? now
        firstUnsavedKeystroke = first
        return min(now + Self.quietPeriod, first + Self.maximumDelay)
    }

    public mutating func saved() {
        firstUnsavedKeystroke = nil
    }
}
