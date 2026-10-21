import Foundation

/// An opaque sRGB colour, each component in 0...1.
public struct ThemeRGB: Equatable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double

    public init(red: Double, green: Double, blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }

    public init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// WCAG 2.x relative luminance.
    public var relativeLuminance: Double {
        func linear(_ channel: Double) -> Double {
            channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    /// The WCAG contrast ratio of this colour drawn on `background`, from 1
    /// to 21. Body text needs 4.5 (AA).
    public func contrast(on background: ThemeRGB) -> Double {
        let lighter = max(relativeLuminance, background.relativeLuminance)
        let darker = min(relativeLuminance, background.relativeLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }
}

public enum ThemeAppearance: CaseIterable, Sendable {
    case light
    case dark
}

/// nitpick's palette: one sRGB value per appearance for every colour the
/// shell draws itself.
public enum ThemeColor: CaseIterable, Sendable {
    case window
    case inset
    /// Fields and the annotation toolbar, raised above the window.
    case raised
    case hover
    case border
    case strongBorder
    case secondaryText
    case error
    case warning

    /// Surfaces text sits on. Hover is drawn at partial opacity over the
    /// window, so the full colour is the worst case.
    public static let textSurfaces: [ThemeColor] = [.window, .inset, .raised, .hover]
    public static let textColors: [ThemeColor] = [.secondaryText, .error, .warning]

    public func value(in appearance: ThemeAppearance) -> ThemeRGB {
        let (light, dark): (UInt32, UInt32) = switch self {
        case .window: (0xFBFBFC, 0x1E1F22)
        case .inset: (0xF4F5F7, 0x18191C)
        case .raised: (0xFFFFFF, 0x2B2D31)
        case .hover: (0xECEEF1, 0x2F3236)
        case .border: (0xE3E5EA, 0x3A3D43)
        case .strongBorder: (0xD4D7DE, 0x4D5159)
        case .secondaryText: (0x5D636F, 0xA1A7B3)
        case .error: (0xC4281D, 0xFF7A70)
        case .warning: (0x9A4F00, 0xF5A54A)
        }
        return ThemeRGB(hex: appearance == .light ? light : dark)
    }
}
