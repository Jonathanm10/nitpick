import Foundation

/// What kind of feedback a Finding is (glossary: Type). nitpick-owned
/// vocabulary — Bug or Improvement, always set — never mapped to a
/// project's native `Type` field: that bundle has no honest "Improvement"
/// value (ADR-0008). At filing it rides a namespaced tag, the source of
/// truth for the planned v2 verify pass (ADR-0004), which re-checks only
/// Bugs.
public enum FindingType: String, Equatable, Sendable, Codable, CaseIterable {
    /// The build diverges from the design — the common case.
    case bug
    /// A change worth making beyond what was specced.
    case improvement

    /// The instance-side tag a filed Finding of this Type carries —
    /// created on first use like `design-review`, queried alongside it.
    public var tagName: String {
        "nitpick-type:\(rawValue)"
    }

    /// The designer-facing label for the Editor's Type control.
    public var label: String {
        switch self {
        case .bug: "Bug"
        case .improvement: "Improvement"
        }
    }
}
