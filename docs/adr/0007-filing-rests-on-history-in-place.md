# Filing rests on History's newest entry, not a timed payoff

After a successful File all, nitpick holds the finished Review Session on screen as History's newest entry — rendered with the same row the ⌘Y History window uses — until the designer hits Done or drops the next Build. This reverses the earlier "the beat never becomes state" choice, where a 1.2-second `filingPayoff` snapshot auto-returned home: designers lost the freshly created Issue links before they could verify or reference them (PRD story 25) and had to reopen the History window to recover them.

Two lighter fixes were rejected. Enriching the home breadcrumb (`HistoryTraceLine`) to carry the links keeps the auto-return but clutters home permanently and still buries the just-filed set among older sessions. Persisting the result view across quit would re-show a stale receipt on the next launch; the view is a transient post-action state, so a quit or crash simply returns to plain home — the session survives as the newest ⌘Y entry regardless.

## Consequences

- The in-place result view is in-memory only; no new persistence. Done — or a direct Build drop onto it — dismisses it back to the home drop zone.
- Both surfaces render one shared History row view — the private `HistoryWindow.historyRow` is extracted into a reusable component that the in-place head and the ⌘Y window both call — so they stay in lockstep by construction, and, like all History, it shows the Issue link + summary + context, not the screenshots.
- The ⌘Y History window and the home trace line are unchanged; the in-place view is purely additive.
- Deleting the timed beat removes the read-only/frozen special-casing the old `filingPayoff` forced onto the review workspace.
