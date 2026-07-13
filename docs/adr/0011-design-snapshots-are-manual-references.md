# Design Snapshots are manual references, not a Figma integration

ADR-0003 remains the rule for a Design Reference: it is an optional URL, and nitpick does not fetch or authenticate with Figma. A Finding may additionally carry multiple manually supplied Design Snapshots because the designer sometimes needs to show an exact visual reference in the filed Issue; nitpick lets the designer inspect and name them, but deliberately provides no image editing, side-by-side comparison, overlay, or visual diffing.

## Consequences

- Design Snapshots belong only to one Finding and are independent of its Design Reference.
- They file as separate, named Issue attachments; they do not alter the Issue description or metadata block.
- Nitpick owns them only while the Review Session is open or filing can still be retried. After successful filing, YouTrack is their system of record.
