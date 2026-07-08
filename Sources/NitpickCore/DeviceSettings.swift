import Foundation

/// The settings half of a Device Context: the simulator's accessibility
/// state — Dynamic Type size, appearance, and Increase Contrast. nitpick
/// no longer owns these (ADR-0009): the designer drives them in the
/// simulator, and the core reads the live state at capture time to stamp
/// each Finding's Accessibility line, so the stamp reflects exactly the
/// conditions the screenshot was taken under.
public struct DeviceSettings: Equatable, Sendable {
    /// The simulator's preferred content size category. Raw values are the
    /// exact `simctl ui <device> content_size` arguments.
    public enum DynamicTypeSize: String, CaseIterable, Equatable, Sendable {
        case extraSmall = "extra-small"
        case small = "small"
        case medium = "medium"
        case large = "large"
        case extraLarge = "extra-large"
        case extraExtraLarge = "extra-extra-large"
        case extraExtraExtraLarge = "extra-extra-extra-large"
        case accessibilityMedium = "accessibility-medium"
        case accessibilityLarge = "accessibility-large"
        case accessibilityExtraLarge = "accessibility-extra-large"
        case accessibilityExtraExtraLarge = "accessibility-extra-extra-large"
        case accessibilityExtraExtraExtraLarge = "accessibility-extra-extra-extra-large"

        /// iOS's default size.
        public static let `default`: DynamicTypeSize = .large

        /// The size's name in the metadata block's Accessibility line and
        /// in the shell's picker — Apple's HIG typography vocabulary
        /// (XS…XXXL, AX1…AX5), the names designers already use. Part of
        /// the ADR-0004 contract: the v2 verify pass parses these back
        /// out of filed issues.
        public var displayName: String {
            switch self {
            case .extraSmall: "XS"
            case .small: "S"
            case .medium: "M"
            case .large: "L"
            case .extraLarge: "XL"
            case .extraExtraLarge: "XXL"
            case .extraExtraExtraLarge: "XXXL"
            case .accessibilityMedium: "AX1"
            case .accessibilityLarge: "AX2"
            case .accessibilityExtraLarge: "AX3"
            case .accessibilityExtraExtraLarge: "AX4"
            case .accessibilityExtraExtraExtraLarge: "AX5"
            }
        }
    }

    /// The simulator's user interface appearance style. Raw values are the
    /// exact `simctl ui <device> appearance` arguments.
    public enum Appearance: String, CaseIterable, Equatable, Sendable {
        case light
        case dark

        /// iOS's default appearance.
        public static let `default`: Appearance = .light
    }

    public var dynamicTypeSize: DynamicTypeSize
    public var appearance: Appearance
    /// Whether the simulator's Increase Contrast accessibility setting is
    /// on. Read back from `simctl ui <device> increase_contrast`; defaults
    /// off, the iOS default.
    public var increaseContrast: Bool

    public init(
        dynamicTypeSize: DynamicTypeSize = .default,
        appearance: Appearance = .default,
        increaseContrast: Bool = false
    ) {
        self.dynamicTypeSize = dynamicTypeSize
        self.appearance = appearance
        self.increaseContrast = increaseContrast
    }

    /// The human-readable non-default settings, in the metadata block's
    /// display order — Dynamic Type, then Dark Mode, then Increase
    /// Contrast. Empty when everything is default: the Accessibility line
    /// is then omitted (ADR-0004).
    public var accessibilityDescriptions: [String] {
        var descriptions: [String] = []
        if dynamicTypeSize != .default {
            descriptions.append("Dynamic Type \(dynamicTypeSize.displayName)")
        }
        if appearance == .dark {
            descriptions.append("Dark Mode")
        }
        if increaseContrast {
            descriptions.append("Increase Contrast")
        }
        return descriptions
    }
}
