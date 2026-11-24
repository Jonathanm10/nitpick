# A release uploads its Build with a token

For AP, a developer's fastlane release makes the simulator Review build, and a PO then drags its zip onto Home, which adds it to the Build Library (ADR-0016). The release can add the Build itself. The releaser is on the office VPN, so the release reaches the Device Host over HTTPS, as a Reviewer's browser does.

## Decision

- **One upload token per Device Host.** It is `NITPICK_UPLOAD_TOKEN` in `server.env`, at least 32 characters, and the server refuses to start with a shorter one. Without it, uploads from a release are off.
- **The release sends the zip to `POST /api/library?name=<zip name>`** with `Authorization: Bearer <token>`. The route runs before the same-origin and sign-in gates and reads no cookie. The token is its only credential, read from that header only and compared in constant time. A missing or wrong token answers 401 before the body is read. A host without a token answers 404.
- **The server process writes the Build.** The route calls the Build Library's `add`, as a Reviewer's upload does, so the zip passes the same checks and a refusal has the same message and status. The Build is no Reviewer's pick, so no open Review Session ends.
- **The uploader is the releaser's name** from `X-Nitpick-Uploader`, read as UTF-8 and cut at 100 characters, or "Release" without one. Its login is empty. No YouTrack account has an empty login, so the entry is never taken for a Reviewer's upload.

## Considered Options

- **SSH and a CLI on the host.** Rejected for two reasons. An SSH key would give each releaser a shell on the Device Host. And a second process writing `<data>/library` breaks ADR-0016: a new `BuildLibrary` removes every folder without `entry.json` at its first operation, which deletes a browser upload in flight, and its delete lock holds within one process only.
- **A Reviewer's token.** Rejected: the release would act as that Reviewer, with a YouTrack token that can read and file Issues in their name. Its upload would also pick the Build for that Reviewer and end their open Review Session.

## Consequences

- **ADR-0002 still holds.** Acquisition stays human: a developer runs the release that uploads the Build. nitpick fetches no Build itself.
- **The token is one shared secret.** Whoever holds it can add Builds, and do nothing else. The host's operator hands it to releasers out of band. Rotating it means changing it in `server.env` and restarting, and every releaser needs the new one.
- **The uploader's name is what the release sends.** Nothing checks it against a person.
- **Each upload adds a Build.** A release run twice lists its Build twice, as two drags onto Home do, and a Reviewer deletes the extra one.
