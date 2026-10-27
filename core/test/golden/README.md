# Golden files from the Swift app

What the Swift app renders and stores, byte for byte. The TypeScript port in `core/` is written against these files. `Tests/NitpickCoreTests/GoldenFileTests.swift` writes them, and `swift test` fails when one drifts, naming the file.

Every golden has a sibling `<name>.input.json` that describes the value it was made from, so a TypeScript test can build the same value without reading Swift. All data is fictional.

## Folders

| Folder | Golden | Swift source | Input description |
| --- | --- | --- | --- |
| `metadata-block/` | `*.txt`: `ReviewSession.metadataBlock(for:)` | `ReviewSession.swift` | `session`, `finding`, and `deviceSettings` when the Device Context was stamped from observed settings |
| `metadata-block/dynamic-type-names.json` | Each Dynamic Type size's stamp name | `DeviceSettings.swift` | The sizes in `simctl`'s vocabulary, in the same order |
| `issue-description/` | `*.txt`: `ReviewSession.issueDescription(for:)` | `ReviewSession.swift` | `session`, `finding` |
| `feedback-description/` | `*.txt`: `Feedback.issueDescription` | `Feedback.swift` | The Feedback, with its Environment as resolved values |
| `stored-session/` | `*.json`: the open-session manifest `session.json` | `SessionPersistence.swift` | `session` |
| `stored-history-entry/` | `*.json`: one `history/*.json` file | `SessionPersistence.swift` | `historyEntry` |
| `images/` | `*.png`: the `annotated.png` filed for a Finding | `AnnotationRendering.swift` | `capture` (a file in this folder) and `annotations` |

## Rules for the port

- **Text** (`*.txt`) matches byte for byte. There is no trailing newline.
- **Stored JSON** matches byte for byte. The port encodes the described value and gets the golden's bytes. It decodes the golden and gets the described value, and re-encoding that gives the same bytes. `design-snapshots-without-data-version.json` is the one exception. It is a manifest from before Replace minted data versions, and it is decode-only. It decodes to the value its `.input.json` describes, where each `dataVersion` equals its `id`. That value encodes to the file named by `reencodesAs`.
- **The unannotated image** passes through unchanged: `unannotated-passthrough.png` is `capture.png`, byte for byte.
- **The flattened image** is compared on decoded pixels, not bytes, using the Swift suite's rule in `Tests/NitpickCoreTests/Support/ImageFixtures.swift`:
  - The dimensions match exactly.
  - A pixel counts as different when any channel differs by more than 32.
  - At most 0.05% of the pixels may differ.

## What Swift's encoder does

The stored JSON uses `JSONEncoder` with sorted keys and unescaped slashes, and no whitespace. These details are easy to miss:

- **Dates** are seconds since 2001-01-01T00:00:00Z as a JSON number, such as `804849332.4729061`. An input description gives a date as `{ "iso8601", "secondsSinceReferenceDate" }`. The second value is exact. The ISO form is for reading and is rounded to milliseconds.
- **Numbers** use the shortest form that reads back as the same double, as JavaScript does, and whole numbers have no `.0`. Two forms differ from `JSON.stringify`: negative zero is `-0`, and exponents have at least two digits (`1e-07` where JavaScript writes `1e-7`). No golden holds either.
- **Points** are `[x, y]`, and rectangles are `[[x, y], [width, height]]`.
- **Enums with payloads** are an object keyed by the case name:
  - A case without a payload is `{"notStarted":{}}`.
  - A labelled payload uses its labels: `{"issueCreated":{"idReadable":…,"issueID":…}}`.
  - An unlabelled payload uses `_0`: `{"filed":{"_0":{…}}}`, `{"rectangle":{"_0":[[…],[…]]}}`, and `{"label":{"_0":"text","at":[…]}}`.
- **Optional values** are left out when nil: `designReference`, `priority`, `assignee`.
- **Strings** keep non-ASCII characters, U+2028 and `/` as they are. Only `"`, `\` and control characters are escaped: `\b \f \n \r \t` by name, the others as `\u0001` with lowercase hex.
- **URLs** are absolute strings. A Build's `appBundleURL` is a `file://` URL ending in `/`.
- **UUIDs** are uppercase.

The input descriptions use a neutral shape where Swift's own encoding isn't plain:

- An Annotation is `{ "kind": "pen" | "arrow" | "rectangle" | "label", "color", … }` with `points`, `from` and `to`, `rect`, or `text` and `at`.
- A filing state is `{ "state", "issueID", "idReadable" }`, or `{ "state": "filed", "issue" }`.

Image bytes are left out of the descriptions, because the stored JSON never holds them.

## Re-recording

Re-record only when a Swift change is meant to change a golden:

```sh
NITPICK_RECORD_SNAPSHOTS=1 swift test --filter GoldenFileTests
swift test
```

A recording run fails on purpose, so it can't pass by accident. Review the diff before you commit it. `flattened-four-tools.png` is also re-recorded, and its bytes change with the macOS version even when its pixels don't.
