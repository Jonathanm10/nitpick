# Nitpick

A macOS companion app for design review of mobile apps: a designer captures what's on screen, annotates it, and files it to YouTrack — closing the loop between design and implementation.

## Language

**Capture Source**:
Where a Finding's screenshot comes from: the booted simulator or a mirroring window (iPhone Mirroring, Bezel). Each source contributes what metadata it can.
_Avoid_: mirror, device (the device is what a source shows, not the source itself)

**Build**:
A specific compiled instance of the app under review, identified by bundle ID, version, and build number.
_Avoid_: artifact, binary

**Review Session**:
One sitting in which a designer reviews a Build. Fixes the shared context once — Build and YouTrack project — and collects Findings until the designer files them. Its Findings may span multiple Device Contexts.
_Avoid_: batch, review round

**Device Context**:
The device and settings in effect when a Finding is captured: device model, OS version, and accessibility settings (Dynamic Type, contrast, …). Stamped on each Finding, not on the Review Session.
_Avoid_: device configuration, environment

**Annotation**:
A markup element — pen stroke, arrow, rectangle, or text label — laid over a Finding's screenshot. Editable until the Finding is filed.
_Avoid_: drawing, markup

**Finding**:
A single discrepancy captured during a Review Session: one annotated screenshot plus the designer's description. Files as exactly one YouTrack issue.
_Avoid_: disparity, nitpick, issue (reserved for the YouTrack artifact)

**Design Reference**:
An optional Figma URL on a Review Session or a Finding, pointing at the design source of truth. A link, never a rendering.
_Avoid_: mockup, design spec
