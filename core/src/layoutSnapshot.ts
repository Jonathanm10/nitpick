// What Inspect shows of the running Build (ADR-0015): the elements SwiftUI
// laid out on the screen, each with its frame and the layout values a
// designer reads in Figma's dev mode. The server builds it from SwiftUI's own
// debug tree, so the page hovers over it without knowing SwiftUI.

/** A rectangle in screen points, from the screen's top left corner. */
export interface LayoutFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Space per edge, in points. Leading and trailing follow the layout
 * direction: left and right in a left-to-right language.
 */
export interface LayoutInsets {
  readonly top: number
  readonly leading: number
  readonly bottom: number
  readonly trailing: number
}

export interface LayoutText {
  readonly content: string
  /**
   * The font's PostScript name: "AvenirNext-DemiBold", or ".SFUI-Semibold"
   * for the system font.
   */
  readonly font: string
  /** Its family as iOS names it: "Avenir Next", ".AppleSystemUIFont". */
  readonly family: string
  readonly size: number
  /**
   * On CSS's scale: 400 regular, 500 medium, 600 semibold, 700 bold.
   * Absent when the Build's font couldn't be read.
   */
  readonly weight?: number
  /** Extra space between letters, in points; absent when there is none. */
  readonly tracking?: number
  /**
   * From one baseline to the next, in points: the font's own line height,
   * or the one the text sets, plus any line spacing. Absent when the
   * Build's font couldn't be read.
   */
  readonly lineHeight?: number
  /** "#RRGGBB" in sRGB, or "#RRGGBBAA" when it isn't opaque. */
  readonly color?: string
}

export interface LayoutElement {
  /** Holds across snapshots of a screen as long as its structure does. */
  readonly id: string
  /** The element this one sits in; absent at the top. */
  readonly parent?: string
  /**
   * What it is: "Text", "Image", "VStack", "LazyVGrid", "RoundedRectangle",
   * "Frame" for a fixed or flexible frame, "View" for anything else, or the
   * app's own component, such as "AcmeButton", where its properties name it.
   */
  readonly name: string
  readonly frame: LayoutFrame
  /** Its padding, between its frame and its content. */
  readonly padding?: LayoutInsets
  /** A stack's spacing between its children, as the app declares it. */
  readonly spacing?: {
    readonly axis: "horizontal" | "vertical"
    readonly value: number
  }
  /**
   * A grid's spacing between its columns (horizontal) and between its rows
   * (vertical), as the app declares it.
   */
  readonly gridSpacing?: {
    readonly horizontal: number
    readonly vertical: number
  }
  readonly text?: LayoutText
  /** An image's name: an SF Symbol's, such as "cart", or an asset's. */
  readonly image?: string
  readonly cornerRadius?: number
  /**
   * "#RRGGBB" in sRGB, or "#RRGGBBAA" when it isn't opaque; or the name of
   * a system colour, such as "red", whose value follows the appearance.
   */
  readonly fill?: string
  /**
   * The app's own enum-valued properties by name, as its source spells
   * them: { style: "primary", size: "regular" }.
   */
  readonly properties?: Readonly<Record<string, string>>
}

export interface LayoutSnapshot {
  /** The screen in points; a point is `scale` of the device's pixels. */
  readonly screen: {
    readonly width: number
    readonly height: number
    readonly scale: number
  }
  /**
   * Back to front, as they are drawn: an element comes after the one it sits
   * in, and later ones lie on top. The element under a point is the last one
   * whose frame holds it.
   */
  readonly elements: ReadonlyArray<LayoutElement>
}
