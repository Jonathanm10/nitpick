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

**Editor**:
The pane where the selected Finding is annotated and described. A Finding stays editable here until it is filed.
_Avoid_: canvas, surface, compose area

**Finding**:
A single discrepancy captured during a Review Session: one annotated screenshot plus the designer's description. Files as exactly one YouTrack Issue.
_Avoid_: disparity, nitpick, issue (reserved — the artifact is an Issue)

**Issue**:
The YouTrack artifact a filed Finding becomes, referenced locally only by its readable ID and URL — never a live mirror of its later YouTrack state.
_Avoid_: ticket, bug, card

**Tray**:
The Review Session's Findings in capture order, awaiting filing. A Finding leaves the Tray only by being filed or discarded.
_Avoid_: queue, basket, list

**History**:
The designer's own record of filed Review Sessions and the Issues their Findings became. Written only at filing — a discarded session leaves no trace — and never reflects later changes in YouTrack.
_Avoid_: log, archive, recents

**Design Reference**:
An optional Figma URL on a Review Session or a Finding, pointing at the design source of truth. A link, never a rendering.
_Avoid_: mockup, design spec
