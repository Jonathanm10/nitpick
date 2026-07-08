# Nitpick observes accessibility state, it does not own it

Nitpick no longer applies Dynamic Type, appearance, or Increase Contrast to the simulator on launch. The designer drives those settings in the simulator directly; nitpick reads the live state (`simctl ui <device> {content_size,appearance,increase_contrast}`, each returns the current value when invoked with no argument) at capture time and stamps it onto the Finding's Device Context. This reverses the accessibility-ownership behavior the code previously attributed to ADR-0002 — nitpick still owns the *Build* lifecycle (boot, install, launch) for provenance, but not the device's accessibility state.

## Considered Options

- **Own the settings (prior behavior).** Nitpick set the settings on every launch, so the simulator was guaranteed to be in a state nitpick chose and the stamp came from nitpick's own record. Cost: a nitpick control per setting, and the designer could not use the simulator's own accessibility affordances without the stamp silently going stale.
- **Observe the settings (chosen).** Nitpick reads the live state per capture. The stamp reflects whatever the designer set, read fresh each time so it still cannot lie. Removes the in-app controls entirely, and lets the observed set grow to whatever `simctl ui` can read — we added Increase Contrast at no UI cost.

## Consequences

- The `Accessibility:` metadata line (ADR-0004) is now sourced by read-back, not by nitpick's own record, and gains an `Increase Contrast` token when enabled. The line is already variable-length (defaults omitted, items appended), so this is additive — no schema version bump.
- The read and the screenshot are not atomic. A settings change in the sub-second window between them could mis-stamp a single capture. Accepted: same class as the existing capture-time race already noted in `captureScreen`.
- Accessibility state is capture metadata only — it is written into the filed issue and is not surfaced in nitpick's UI.
