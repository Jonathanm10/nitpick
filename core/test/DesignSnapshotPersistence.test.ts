// Ports the codec cases of
// Tests/NitpickCoreTests/DesignSnapshotPersistenceTests.swift. The image
// files are the server's: a manifest names each snapshot's bytes by its
// dataVersion, and the server keeps them beside it.
import { describe, expect, test } from "vitest"
import type { DesignSnapshot } from "../src/designSnapshot.ts"
import {
  addFinding,
  updateFinding,
  type ReviewSession,
} from "../src/reviewSession.ts"
import { decodeStoredSession, encodeStoredSession } from "../src/storage.ts"
import { newUUID } from "../src/uuid.ts"
import * as fixtures from "./fixtures.ts"

function sessionWithSnapshot() {
  const { session, id: findingID } = addFinding(
    fixtures.session,
    fixtures.finding()
  )
  const snapshotID = newUUID()
  const snapshot: DesignSnapshot = {
    id: snapshotID,
    dataVersion: snapshotID,
    name: "button.png",
    mediaType: "png",
  }
  return {
    session: updateFinding(session, findingID, (finding) => ({
      ...finding,
      designSnapshots: [snapshot],
    })),
    findingID,
    snapshotID,
  }
}

/** What a Replace leaves in the manifest: same id and name, new bytes. */
function replacing(session: ReviewSession, findingID: string): ReviewSession {
  return updateFinding(session, findingID, (finding) => ({
    ...finding,
    designSnapshots: finding.designSnapshots.map((snapshot) => ({
      ...snapshot,
      dataVersion: newUUID(),
    })),
  }))
}

describe("Design Snapshot persistence", () => {
  test("a Replace persists the new bytes, a relaunch reads them, and the old file is pruned", () => {
    const { session, findingID, snapshotID } = sessionWithSnapshot()
    const replaced = replacing(session, findingID)

    const resumed = decodeStoredSession(encodeStoredSession(replaced))

    const [snapshot] = resumed.tray[0].finding.designSnapshots
    expect(snapshot.id).toBe(snapshotID)
    expect(snapshot.name).toBe("button.png")
    expect(snapshot.dataVersion).not.toBe(snapshotID)
    expect(snapshot).toEqual(replaced.tray[0].finding.designSnapshots[0])
  })

  test("a manifest written before data versions resumes its snapshots, and a later Replace still persists", () => {
    const { session, findingID, snapshotID } = sessionWithSnapshot()
    const stored = JSON.parse(encodeStoredSession(session))
    // The pre-data-version shape: snapshots named their file by `id`.
    for (const item of stored.tray) {
      for (const snapshot of item.designSnapshots) delete snapshot.dataVersion
    }

    const resumed = decodeStoredSession(JSON.stringify(stored))
    expect(resumed.tray[0].finding.designSnapshots[0].dataVersion).toBe(
      snapshotID
    )

    const replaced = replacing(resumed, findingID)
    expect(decodeStoredSession(encodeStoredSession(replaced))).toEqual(replaced)
  })
})
