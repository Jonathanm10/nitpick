// Ports the metadata block, issue description, Feedback description, stored
// session and History cases of Tests/NitpickCoreTests/GoldenFileTests.swift:
// the port renders and stores what the Swift app does, byte for byte. The
// images are server/test/AnnotationFlattening.test.ts's.
import { describe, expect, test } from "vitest"
import {
  deviceContextOf,
  dynamicTypeDisplayName,
  dynamicTypeSizes,
  type DeviceSettings,
} from "../src/deviceContext.ts"
import { feedbackDescription, type Feedback } from "../src/feedback.ts"
import { issueDescription, metadataBlock } from "../src/reviewSession.ts"
import {
  decodeStoredHistoryEntry,
  decodeStoredSession,
  encodeStoredHistoryEntry,
  encodeStoredSession,
  UnsupportedStoredSchema,
} from "../src/storage.ts"
import {
  expectMatchesGolden,
  goldenInput,
  goldenText,
  historyEntryFrom,
  sessionFrom,
  type DescribedHistoryEntry,
  type SessionAndFinding,
} from "./golden.ts"

const metadataBlockGoldens = [
  "minimal",
  "accessibility",
  "design-reference",
  "accessibility-and-design-reference",
  "session-design-reference",
  "finding-design-reference-overrides-session",
  "device-settings-default",
  "device-settings-dynamic-type-and-dark-mode",
  "device-settings-dynamic-type-alone",
  "device-settings-increase-contrast",
  "device-settings-increase-contrast-alone",
  "fractional-session-start",
]

const storedSessionGoldens = [
  "filing-progress",
  "annotations",
  "triage",
  "design-snapshots",
  "design-snapshots-replaced",
]

describe("Golden files", () => {
  test.each(metadataBlockGoldens)("metadata block (%s)", (name) => {
    const input = goldenInput<
      SessionAndFinding & { deviceSettings?: DeviceSettings }
    >(`metadata-block/${name}.input.json`)
    if (input.deviceSettings !== undefined) {
      // Stamped from observed settings, as a capture does (ADR-0009).
      expect(
        deviceContextOf(
          { name: "iPhone 17 Pro", osName: "iOS 26.4" },
          input.deviceSettings
        )
      ).toEqual(input.finding.deviceContext)
    }

    expectMatchesGolden(
      metadataBlock(sessionFrom(input.session), input.finding),
      `metadata-block/${name}.txt`
    )
  })

  test("every Dynamic Type size's stamp name, in size order", () => {
    expect(dynamicTypeSizes).toEqual(
      goldenInput("metadata-block/dynamic-type-names.input.json")
    )
    expect(dynamicTypeSizes.map(dynamicTypeDisplayName)).toEqual(
      goldenInput("metadata-block/dynamic-type-names.json")
    )
  })

  test.each(["with-designer-text", "without-designer-text"])(
    "issue description (%s)",
    (name) => {
      const input = goldenInput<SessionAndFinding>(
        `issue-description/${name}.input.json`
      )

      expectMatchesGolden(
        issueDescription(sessionFrom(input.session), input.finding),
        `issue-description/${name}.txt`
      )
    }
  )

  test.each([
    "with-review-session",
    "without-review-session",
    "without-description",
  ])("Feedback description (%s)", (name) => {
    const input = goldenInput<Feedback>(
      `feedback-description/${name}.input.json`
    )

    expectMatchesGolden(
      feedbackDescription(input),
      `feedback-description/${name}.txt`
    )
  })

  test.each(storedSessionGoldens)("stored open session (%s)", (name) => {
    const path = `stored-session/${name}.json`
    const session = sessionFrom(
      goldenInput<SessionAndFinding>(`stored-session/${name}.input.json`)
        .session
    )

    expectMatchesGolden(encodeStoredSession(session), path)

    // Decoding the golden gives back the session, and encoding that gives
    // back the golden's bytes.
    const decoded = decodeStoredSession(goldenText(path))
    expect(decoded).toEqual(session)
    expectMatchesGolden(encodeStoredSession(decoded), path)
  })

  test("stored open session without dataVersion decodes to the design-snapshots session", () => {
    const input = goldenInput<
      Pick<SessionAndFinding, "session"> & { reencodesAs: string }
    >("stored-session/design-snapshots-without-data-version.input.json")

    const decoded = decodeStoredSession(
      goldenText("stored-session/design-snapshots-without-data-version.json")
    )

    expect(decoded).toEqual(sessionFrom(input.session))
    expectMatchesGolden(
      encodeStoredSession(decoded),
      `stored-session/${input.reencodesAs}`
    )
  })

  test("stored History entry", () => {
    const path = "stored-history-entry/history-entry.json"
    const entry = historyEntryFrom(
      goldenInput<{ historyEntry: DescribedHistoryEntry }>(
        "stored-history-entry/history-entry.input.json"
      ).historyEntry
    )

    expectMatchesGolden(encodeStoredHistoryEntry(entry), path)

    const decoded = decodeStoredHistoryEntry(goldenText(path))
    expect(decoded).toEqual(entry)
    expectMatchesGolden(encodeStoredHistoryEntry(decoded), path)
  })

  // UnsupportedStoredSchema in Sources/NitpickCore/SessionPersistence.swift,
  // which no Swift test covers: a file from any other schema is refused with
  // its message, never guessed at.
  test.each([
    {
      golden: "stored-session/filing-progress.json",
      decode: decodeStoredSession,
    },
    {
      golden: "stored-history-entry/history-entry.json",
      decode: decodeStoredHistoryEntry,
    },
  ])(
    "a stored file of another schema is refused ($golden)",
    ({ golden, decode }) => {
      for (const version of [2, 0, 17]) {
        const other = goldenText(golden).replace(
          '"schemaVersion":1',
          `"schemaVersion":${version}`
        )

        expect(() => decode(other)).toThrow(UnsupportedStoredSchema)
        expect(() => decode(other)).toThrow(
          `This review data was saved by a newer version of nitpick (schema ${version}). Update nitpick to open it.`
        )
      }
      // Swift decodes the whole file before it reads the version, so a newer
      // shape failed as corrupt; the port reads the version first.
      expect(() => decode('{"schemaVersion":2,"renamed":[]}')).toThrow(
        UnsupportedStoredSchema
      )
    }
  )
})
