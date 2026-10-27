# Nitpick

A web app for design review of mobile apps: a Reviewer runs a Build on a Device Host, captures what's on screen, annotates it, and files it to YouTrack — closing the loop between design and implementation.

## Language

**Reviewer**:
A person who runs Review Sessions: a designer or a PO. Files under their own YouTrack account.
_Avoid_: user, tester, designer (a designer is one kind of Reviewer)

**Device Host**:
Where a Review Session's device runs: the machine that boots the simulator or emulator, installs the Build, and streams its screen to the Reviewer's browser. A shared Liip office Mac mini is one.
_Avoid_: server, mini, CI machine, runner

**Capture Source**:
Where a Finding's screenshot comes from: the simulator or emulator running the Build on the Device Host, captured at native pixels, never the live view in the browser. Each source contributes what metadata it can.
_Avoid_: mirror, stream, device (the device is what a source shows, not the source itself)

**Build**:
A specific compiled instance of the app under review, identified by app ID (iOS bundle ID or Android package name), version, and build number.
_Avoid_: artifact, binary

**Review Session**:
One sitting in which a Reviewer reviews a Build. Fixes the shared context once — Build and YouTrack project — and collects Findings until the Reviewer files them. Its Findings may span multiple Device Contexts.
_Avoid_: batch, review round

**Device Context**:
The device and settings in effect when a Finding is captured: device model, OS version, and accessibility settings (text size, appearance, contrast, …). Stamped on each Finding, not on the Review Session.
_Avoid_: device configuration, environment

**Annotation**:
A markup element — pen stroke, arrow, rectangle, or text label — laid over a Finding's screenshot or a Feedback's window image. Editable until the Finding is filed or the Feedback is sent.
_Avoid_: drawing, markup

**Editor**:
The pane where the selected Finding is annotated and described. A Finding stays editable here until it is filed.
_Avoid_: canvas, surface, compose area

**Finding**:
A single point of design-review feedback on the Build — a Bug or an Improvement (see Type) — captured as one annotated screenshot plus the Reviewer's description and optional Design Snapshots. Files as exactly one Issue.
_Avoid_: disparity, nitpick, issue (reserved — the artifact is an Issue)

**Type**:
What kind of feedback a Finding is: a Bug (the build diverges from the design) or an Improvement (a change worth making beyond what was specced). Exactly one per Finding.
_Avoid_: category, kind, bug/improvement (those are Type values, not the field)

**Priority**:
How soon a filed Finding should be addressed relative to others, in the target project's own priority scale.
_Avoid_: severity, urgency, importance

**Assignee**:
The project member a filed Finding is assigned to, chosen from the target project's assignable users. Optional — a Finding may be unassigned.
_Avoid_: owner, responsible, reviewer

**Issue**:
The YouTrack artifact a filed Finding or a sent Feedback becomes, referenced locally only by its readable ID and URL — never a live mirror of its later YouTrack state.
_Avoid_: ticket, bug, card

**Tray**:
The Review Session's Findings in capture order, awaiting filing. A Finding leaves the Tray only by being filed or discarded.
_Avoid_: queue, basket, list

**History**:
The shared record of filed Review Sessions and the Issues their Findings became, visible to every Reviewer. Written only at filing — a discarded session leaves no trace — and never reflects later changes in YouTrack.
_Avoid_: log, archive, recents

**Design Reference**:
An optional Figma URL on a Review Session or a Finding, pointing at the design source of truth. A link, never a rendering.
_Avoid_: mockup, design spec

**Design Snapshot**:
An optional named static image from the design, attached to a Finding as visual reference alongside its captured app screenshot and independently of any Design Reference. A Finding may carry several Design Snapshots; each has a default name the Reviewer may refine, and supports inspection rather than visual diffing or image editing.
_Avoid_: attachment, Figma capture, comparison image

**Feedback**:
A Reviewer's report about nitpick itself — a Bug (nitpick misbehaves) or an Improvement (a change worth making to nitpick) — with a title, a description, the versions in play, and optionally an image of nitpick carrying Annotations. Sent as exactly one Issue to the nitpick project; never part of a Review Session or History.
_Avoid_: bug report, ticket, finding (a Finding is about the Build under review, not about nitpick)
