# Nitpick uses macOS-native interaction idioms, not iOS ones

Nitpick is a Mac app, so its affordances follow AppKit conventions — hover-revealed controls, a small remove glyph, a confirmation round-trip — rather than the touch idioms a SwiftUI developer reaches for by habit. The concrete trigger: the Tray's Discard affordance moves off `swipeActions` (built for PRD stories 17–18) to a plain `×` glyph revealed on hover and on selection. Swipe-to-act is a phone gesture; on a pointer-driven Mac list it is undiscoverable and unidiomatic, and it was the one thing forcing the row into a `List`-shaped mould.

## Considered Options

- **Swipe-to-discard (prior, PRD 17–18).** The row lived in a `List` so the platform owned swipe physics; a trailing swipe revealed a Discard button (no full swipe — the confirmation still guarded the act). Cost: a gesture Mac users don't try, invisible until attempted, and carried purely to host the swipe.
- **Hover / selection `×` (chosen).** A small `secondaryText` `×` with a faint circular hover background, shown on hover and whenever the row is selected (so keyboard-only use keeps the affordance), staging the same confirmation. The Mac-native pattern — Safari tabs, token fields — and reachable without a gesture nobody performs.

## Consequences

- PRD stories 17–18 (swipe reveal, no full-swipe commit) are superseded by the hover/selection `×`. The reduced-motion and full-swipe reasoning they carried no longer applies.
- The destructive-discard **confirmation round-trip is unchanged** — the Tray still keeps no undo, so `×` stages the dialog, it does not act. Only the trigger changed, never the safety.
- The Tray keeps its `List` for content-sized height, compression, scrolling, and the filed/interrupted row states; it simply no longer needs `swipeActions`. Should those `List` workarounds ever outlast their value, shedding `List` for a `ScrollView` is now unblocked — nothing else depended on the swipe.
- The principle generalises: future UI prefers hover-reveal, `×`/close glyphs, and pointer/keyboard affordances over swipe, long-press, and other touch gestures, even where a UIKit instinct suggests otherwise.
