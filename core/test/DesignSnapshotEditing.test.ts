// Ports the editing halves of Tests/NitpickCoreTests/DesignSnapshotScenarioTests.swift:
// adding, renaming, replacing and removing a Finding's Design Snapshots, and
// the names and media types they keep. Whether the bytes decode, and their
// files on disk, are the server's (server/test/DesignSnapshotAPI.test.ts).
import { describe, expect, test } from "vitest"
import {
  addDesignSnapshot,
  designSnapshotMediaType,
  DesignSnapshotError,
  normalizedDesignSnapshotName,
  removeDesignSnapshot,
  renameDesignSnapshot,
  replaceDesignSnapshot,
} from "../src/designSnapshot.ts"
import { addFinding } from "../src/reviewSession.ts"
import * as fixtures from "./fixtures.ts"

function sessionWithFinding(summary = "Wrong padding") {
  return addFinding(fixtures.session, fixtures.finding({ summary }))
}

function thrown(action: () => unknown): DesignSnapshotError {
  try {
    action()
  } catch (error) {
    if (error instanceof DesignSnapshotError) return error
    throw error
  }
  throw new Error("expected a DesignSnapshotError")
}

describe("Design Snapshots", () => {
  test("multiple Findings keep independent snapshots through rename, replace, removal", () => {
    const { session: base, id: first } = sessionWithFinding("First")
    const added = addFinding(base, fixtures.finding({ summary: "Second" }))
    let session = added.session
    const second = added.id

    const kept = addDesignSnapshot(session, first, {
      name: "button.png",
      mediaType: "png",
    })
    const removed = addDesignSnapshot(kept.session, first, {
      name: "wrong.png",
      mediaType: "png",
    })
    session = addDesignSnapshot(removed.session, second, {
      name: "other-finding.png",
      mediaType: "png",
    }).session

    session = renameDesignSnapshot(
      session,
      first,
      kept.snapshot.id,
      "approved-button.png"
    )
    const replaced = replaceDesignSnapshot(
      session,
      first,
      kept.snapshot.id,
      "png"
    )
    session = removeDesignSnapshot(replaced.session, first, removed.snapshot.id)

    const firstSnapshots = session.tray[0].finding.designSnapshots
    expect(firstSnapshots).toEqual([
      {
        id: kept.snapshot.id,
        dataVersion: replaced.snapshot.dataVersion,
        name: "approved-button.png",
        mediaType: "png",
      },
    ])
    expect(replaced.snapshot.dataVersion).not.toBe(kept.snapshot.id)
    expect(
      session.tray[1].finding.designSnapshots.map((snapshot) => snapshot.name)
    ).toEqual(["other-finding.png"])
  })

  test("a new snapshot's dataVersion starts equal to its id", () => {
    const { session, id } = sessionWithFinding()

    const { snapshot } = addDesignSnapshot(session, id, {
      name: "spec.png",
      mediaType: "png",
    })

    expect(snapshot.dataVersion).toBe(snapshot.id)
  })

  test("rename and replacement keep attachment extensions truthful", () => {
    const { session: base, id } = sessionWithFinding()
    const added = addDesignSnapshot(base, id, {
      name: "button.png",
      mediaType: "png",
    })

    const renamed = renameDesignSnapshot(
      added.session,
      id,
      added.snapshot.id,
      "approved.jpg"
    )
    expect(renamed.tray[0].finding.designSnapshots[0].name).toBe("approved.png")

    const replaced = replaceDesignSnapshot(
      renamed,
      id,
      added.snapshot.id,
      "jpeg"
    ).session
    expect(replaced.tray[0].finding.designSnapshots[0]).toMatchObject({
      name: "approved.jpg",
      mediaType: "jpeg",
    })
  })

  test("a file's media type comes from its extension, and anything else is refused by name", () => {
    expect(designSnapshotMediaType("layout.png")).toBe("png")
    expect(designSnapshotMediaType("detail.jpeg")).toBe("jpeg")
    expect(designSnapshotMediaType("DETAIL.JPG")).toBe("jpeg")
    expect(thrown(() => designSnapshotMediaType("notes.pdf")).message).toBe(
      ".pdf is not supported. Choose a PNG or JPEG image."
    )
    expect(thrown(() => designSnapshotMediaType("README")).message).toBe(
      "This file is not supported. Choose a PNG or JPEG image."
    )
  })

  test("a name keeps a truthful extension, gains a missing one and refuses blank", () => {
    expect(normalizedDesignSnapshotName(" layout.png ", "png")).toBe(
      "layout.png"
    )
    expect(normalizedDesignSnapshotName("layout", "jpeg")).toBe("layout.jpg")
    expect(normalizedDesignSnapshotName("layout.jpeg", "jpeg")).toBe(
      "layout.jpeg"
    )
    expect(
      thrown(() => normalizedDesignSnapshotName(" \n", "png")).message
    ).toBe("Give the Design Snapshot a name.")
  })

  test("a frozen Finding or a missing snapshot refuses every edit", () => {
    const { session, id } = sessionWithFinding()
    const frozen = fixtures.withFilingProgress(session, id, {
      state: "issueCreated",
      issueID: "3-505",
      idReadable: "RM-421",
    })

    expect(
      thrown(() =>
        addDesignSnapshot(frozen, id, { name: "a.png", mediaType: "png" })
      ).message
    ).toBe("Design Snapshots can only be changed on an editable Finding.")
    expect(
      thrown(() => removeDesignSnapshot(session, id, "missing")).message
    ).toBe("This Design Snapshot is no longer attached to the Finding.")
  })

  test("the byte checks speak today's words", () => {
    expect(new DesignSnapshotError({ kind: "unreadableImage" }).message).toBe(
      "Choose a readable PNG or JPEG image."
    )
    expect(
      new DesignSnapshotError({ kind: "mediaTypeMismatch", expected: "jpeg" })
        .message
    ).toBe("This image is not a valid JPEG file.")
  })
})
