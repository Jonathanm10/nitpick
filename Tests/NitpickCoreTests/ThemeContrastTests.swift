import NitpickCore
import Testing

/// Every text colour nitpick draws meets WCAG AA body contrast (4.5:1) on
/// every surface it sits on, in light and in dark.
@Suite("Theme contrast")
struct ThemeContrastTests {
    @Test("black on white is 21:1 and a colour on itself is 1:1")
    func extremes() {
        let black = ThemeRGB(hex: 0x000000), white = ThemeRGB(hex: 0xFFFFFF)

        #expect(black.contrast(on: white) == 21)
        #expect(white.contrast(on: black) == 21)
        #expect(white.contrast(on: white) == 1)
    }

    @Test("the AA threshold falls between #767676 and #777777 on white")
    func aaBoundary() {
        let white = ThemeRGB(hex: 0xFFFFFF)

        #expect((ThemeRGB(hex: 0x767676).contrast(on: white) * 100).rounded() == 454)
        #expect((ThemeRGB(hex: 0x777777).contrast(on: white) * 100).rounded() == 448)
    }

    @Test("dark draws light text on dark surfaces, light the reverse", arguments: ThemeColor.textSurfaces)
    func appearancesAreNotSwapped(surface: ThemeColor) {
        for text in ThemeColor.textColors {
            #expect(text.value(in: .dark).relativeLuminance > surface.value(in: .dark).relativeLuminance, "\(text) on \(surface) in dark")
            #expect(text.value(in: .light).relativeLuminance < surface.value(in: .light).relativeLuminance, "\(text) on \(surface) in light")
        }
    }

    @Test("every text colour reaches 4.5:1 on every surface", arguments: ThemeAppearance.allCases)
    func textMeetsAA(appearance: ThemeAppearance) {
        for text in ThemeColor.textColors {
            for surface in ThemeColor.textSurfaces {
                let ratio = text.value(in: appearance).contrast(on: surface.value(in: appearance))
                #expect(ratio >= 4.5, "\(text) on \(surface) in \(appearance) is \(ratio):1")
            }
        }
    }
}
