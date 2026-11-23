# Builds live in a shared Build Library on the Device Host

For AP, the one project nitpick serves, the developer zips a simulator Build into a Slack channel folder and deletes old ones after each release. Each PO downloaded the zip and uploaded it to nitpick, which kept one Build per Reviewer, visible only to them, and deleted it at their next upload. So the same Build was uploaded once per PO, and again after a review ended and the server restarted. POs now pick a Build already on the Device Host instead.

## Decision

- **One Build Library per Device Host.** Every upload goes into `<data>/library/<id>/`, which every signed-in Reviewer sees on Home and can start a review on. The folder holds the extracted `.app` or the `.apk` under `build/`, and `entry.json` (schema 1): the Build's name and identity, the bundle's path relative to the folder, who uploaded it and when. `entry.json` is written last, so a folder without one is an upload that never finished, and the server removes it at the Library's first operation after a start. Nothing on disk holds an absolute path: the Build's `file://` URL is made when the entry is read.
- **Builds stay until someone deletes them.** Any signed-in Reviewer may delete any Build. The developer does it after a release, as in the Slack folder today. Nothing deletes Builds automatically.
- **A Build in a review can't be deleted.** It is in use while an open Review Session's Build lies in its folder, or while a start on it is under way. The server reads every Reviewer's open session at each delete: there are few Reviewers, and there is no index to keep in step. A start holds a lease on its Build from its check that the Build exists until its session is saved or the start fails, and that check and every delete run under one lock for the host. So a delete racing a start either goes first and the start is refused, or is refused itself.
- **A Reviewer's Build is a pick.** The Reviewer keeps the id of the Build they picked or uploaded, in memory as before: a restart forgets it, and one whose Build was deleted shows no Build. An upload adds the Build to the Library and picks it. Picking another Build ends the open session as an upload does, ADR-0007's held filing result included; picking the one already theirs changes nothing.
- **The per-Reviewer slots go.** At each Reviewer's first load after the change, their `builds/` and `uploads/` folders are deleted, except the Build an open session from before still runs, which goes when that session ends. Those Builds aren't added to the Library.

## Considered Options

- **Keep one Build per Reviewer.** Rejected: the uploads repeated per PO are the problem.
- **Fetch Builds from CI.** Deferred: AP has no CI yet. The Library is where a CI source would add entries.
- **Copy the Build into each session.** Rejected: it doubles the disk each session takes and adds a copy to every start, only so that a Build could be deleted mid-review.
- **Keep an index of the Builds in use.** Rejected: a second record that every start, end and filing would have to keep in step with the sessions, when reading a few session files at a delete is cheap.
- **Delete old Builds automatically.** Rejected for now: the developer deletes after a release, and a rule like "keep the newest five" could delete a Build a PO is about to review.

## Consequences

- **ADR-0002 holds.** nitpick still installs and launches the Build itself, and acquisition stays human: a developer still uploads the Build they share, once for everyone instead of once per PO.
- **Disk grows until someone deletes.** Each Build takes the disk of its extracted `.app` or its `.apk`, and the nightly backup copies it again for each of the 14 days it keeps (`docs/operations.md`).
- **Everyone sees everything.** Every signed-in Reviewer sees and may delete every Build. nitpick serves one project, reviewed by Liip POs; showing a Build only to its project or its uploader would need a project on each entry.
- **An open session still names its Build by absolute path.** Library entries are relative, but `session.json` keeps the `file://` URL it started on, so an open session doesn't survive moving the data directory to another path.
- **History is unchanged** (ADR-0014): it records the Build's identity, never its files.
