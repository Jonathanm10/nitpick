# Capture is a global hotkey that opens the annotation moment

Capture must work while the designer's hands are on the mirror (Simulator.app today), not only when Nitpick is the key app — a focus switch per Finding taxes the loop at its hottest point. Nitpick registers a global hotkey (default ⌃⌥⌘N) for the lifetime of a Review Session; firing it captures and then activates Nitpick with the fresh Finding selected in the Editor. ⌘⏎ closes the round trip by handing focus back to the mirror.

Two alternatives were rejected. Silent background capture (collect now, annotate later) contradicts the validated workflow: the designer annotates each Finding in the moment, then resumes reviewing. An `NSEvent` global monitor would require the Accessibility/Input Monitoring permission — the same class of prompt ADR-0001 deliberately avoids — so the hotkey uses Carbon `RegisterEventHotKey`, which is permission-free.

## Consequences

- Stealing focus on capture is deliberate, not a bug: capture *is* the designer's decision to annotate now. The cost is symmetric — ⌘⏎ (or ⏎ from the Summary field) must always return them to the mirror in one keystroke.
- The hotkey exists only between Start review and End review; Nitpick never squats on a system-wide shortcut outside a session. ⌘S remains for when Nitpick is already key.
- Carbon Hot Keys is a legacy-but-supported API; if it is ever removed, the fallback decision reopens (an owned mini-panel or accepting a permission prompt).
- The default chord is fixed in v1; a collision with another app's hotkey is resolved by making it configurable, not by choosing a more obscure default.
