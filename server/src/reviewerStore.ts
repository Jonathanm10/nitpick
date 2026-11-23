// One Reviewer's files under the server's data directory: the open Review
// Session as schema v1 JSON (Sources/NitpickCore/SessionPersistence.swift's
// manifest) with its captures and Design Snapshots beside it, and the Recent
// devices. Their Builds are in the Build Library (buildLibrary.ts).
//
//   <reviewer>/open-session/session.json
//   <reviewer>/open-session/captures/<item id>.png
//   <reviewer>/open-session/design-snapshots/<item id>/<data version>.<ext>
//   <reviewer>/open-session/filing             while a File all runs
//   <reviewer>/recent-devices.json
//   <reviewer>/imports/<id>/…         a History import's zips while read
//
// Before the Library, each Reviewer kept their last upload in `builds/<id>/`,
// and its zip in `uploads/` while it was extracted. A session opened then
// still runs its Build from there, so that folder stays until the session
// ends; the rest goes at the Reviewer's first load.
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import {
  decodeStoredSession,
  designSnapshotFileExtension,
  encodeStoredSession,
  newUUID,
  RecentDevices,
  type Build,
  type DesignSnapshot,
  type ReviewSession,
} from "@nitpick/core"

export class ReviewerStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  /** The open session, or undefined when none is open. */
  async openSession(): Promise<ReviewSession | undefined> {
    const json = await readIfPresent(this.#openSessionManifest)
    return json === undefined ? undefined : decodeStoredSession(json)
  }

  /**
   * Writes the manifest, then deletes the captures and Design Snapshot
   * files it no longer names. Their bytes are written first, with
   * `writeCapture` and `writeDesignSnapshot`, so a manifest never names a
   * file that isn't on disk; a crash before the prune leaves orphans the
   * next save removes.
   */
  async saveOpenSession(session: ReviewSession): Promise<void> {
    await writeAtomically(
      this.#openSessionManifest,
      encodeStoredSession(session)
    )
    const liveCaptures = new Set(session.tray.map((item) => `${item.id}.png`))
    await removeAllBut(this.#capturesDirectory, liveCaptures)
    const snapshotsDirectory = this.#designSnapshotsDirectory
    const items = await readdir(snapshotsDirectory).catch(() => [])
    await Promise.all(
      items.map(async (itemID) => {
        const finding = session.tray.find((item) => item.id === itemID)?.finding
        const live = new Set(
          (finding?.designSnapshots ?? []).map(designSnapshotFileName)
        )
        if (live.size === 0) {
          await rm(join(snapshotsDirectory, itemID), {
            recursive: true,
            force: true,
          })
        } else {
          await removeAllBut(join(snapshotsDirectory, itemID), live)
        }
      })
    )
  }

  /** A capture's PNG, written once: its bytes never change. */
  async writeCapture(itemID: string, png: Uint8Array): Promise<void> {
    await writeAtomically(this.capturePath(itemID), png)
  }

  capturePath(itemID: string): string {
    return join(this.#capturesDirectory, `${itemID}.png`)
  }

  /** A Design Snapshot's bytes, under the `dataVersion` that names them. */
  async writeDesignSnapshot(
    itemID: string,
    snapshot: DesignSnapshot,
    data: Uint8Array
  ): Promise<void> {
    await writeAtomically(this.designSnapshotPath(itemID, snapshot), data)
  }

  designSnapshotPath(itemID: string, snapshot: DesignSnapshot): string {
    return join(
      this.#designSnapshotsDirectory,
      itemID,
      designSnapshotFileName(snapshot)
    )
  }

  /**
   * Marks the open session as being filed. A run that ends takes the mark
   * away; one a server restart cut short leaves it, so the next start
   * resumes it.
   */
  async markFiling(): Promise<void> {
    await writeAtomically(this.#filingMark, "")
  }

  async unmarkFiling(): Promise<void> {
    await rm(this.#filingMark, { force: true })
  }

  async isMarkedFiling(): Promise<boolean> {
    return (await readIfPresent(this.#filingMark)) !== undefined
  }

  /**
   * Ends the open session without filing, so it isn't there to resume.
   * Removes the whole slot, captures included. A Build from before the
   * Library that the session ran goes with `removeLegacyBuilds`.
   */
  async clearOpenSession(): Promise<void> {
    await rm(join(this.directory, "open-session"), {
      recursive: true,
      force: true,
    })
  }

  /**
   * Deletes what the Reviewer's own Build slot left from before the Build
   * Library: `uploads/`, and each `builds/<id>/` but the one `keeping`
   * lies in. A `keeping` this host doesn't have, as after a move to
   * another home, may name a slot by a path that isn't its own, so nothing
   * goes until its session ends.
   */
  async removeLegacyBuilds(keeping: Build | undefined): Promise<void> {
    const builds = join(this.directory, "builds")
    const keptPath = keeping && fileURLToPath(keeping.appBundleURL)
    if (keptPath !== undefined && !(await exists(keptPath))) return
    const kept = keptPath && relative(builds, keptPath).split(sep)[0]
    await rm(join(this.directory, "uploads"), { recursive: true, force: true })
    const ids = await readdir(builds).catch(() => [])
    const stale = ids.filter((id) => id !== kept)
    if (stale.length === ids.length) {
      await rm(builds, { recursive: true, force: true })
      return
    }
    await Promise.all(
      stale.map((id) => rm(join(builds, id), { recursive: true, force: true }))
    )
  }

  /** Unreadable or missing data is an empty Recent, as UserDefaults gave. */
  async recentDevices(): Promise<RecentDevices> {
    const json = await readIfPresent(this.#recentDevicesFile)
    try {
      const stored: unknown = JSON.parse(json ?? "{}")
      const udids =
        typeof stored === "object" && stored !== null && "udids" in stored
          ? stored.udids
          : undefined
      return new RecentDevices(
        Array.isArray(udids)
          ? udids.filter((udid) => typeof udid === "string")
          : []
      )
    } catch {
      return new RecentDevices()
    }
  }

  async saveRecentDevices(recent: RecentDevices): Promise<void> {
    await writeAtomically(
      this.#recentDevicesFile,
      JSON.stringify({ udids: recent.udids })
    )
  }

  /** A directory for one History import's zips; it isn't created yet. */
  newImportDirectory(): string {
    return join(this.directory, "imports", newUUID())
  }

  get #openSessionManifest(): string {
    return join(this.directory, "open-session", "session.json")
  }

  get #filingMark(): string {
    return join(this.directory, "open-session", "filing")
  }

  get #capturesDirectory(): string {
    return join(this.directory, "open-session", "captures")
  }

  get #designSnapshotsDirectory(): string {
    return join(this.directory, "open-session", "design-snapshots")
  }

  get #recentDevicesFile(): string {
    return join(this.directory, "recent-devices.json")
  }
}

/** The Build of each Reviewer's open session, for every Reviewer. */
export async function openSessionBuilds(
  reviewersDirectory: string
): Promise<Build[]> {
  const reviewers = await readdir(reviewersDirectory, {
    withFileTypes: true,
  }).catch(() => [])
  const sessions = await Promise.all(
    reviewers
      .filter((reviewer) => reviewer.isDirectory())
      .map((reviewer) =>
        new ReviewerStore(join(reviewersDirectory, reviewer.name)).openSession()
      )
  )
  return sessions
    .filter((session) => session !== undefined)
    .map((session) => session.build)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function designSnapshotFileName(snapshot: DesignSnapshot): string {
  return `${snapshot.dataVersion}.${designSnapshotFileExtension(snapshot.mediaType)}`
}

/** Deletes every file in `directory` whose name `keep` lacks. */
async function removeAllBut(
  directory: string,
  keep: ReadonlySet<string>
): Promise<void> {
  const names = await readdir(directory).catch(() => [])
  await Promise.all(
    names
      .filter((name) => !keep.has(name))
      .map((name) => rm(join(directory, name), { force: true }))
  )
}

/** A crash mid-write keeps the previous good file. */
export async function writeAtomically(
  path: string,
  contents: string | Uint8Array,
  /** The new file's permissions, for a file only the server may read. */
  mode?: number
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${newUUID()}.tmp`
  await writeFile(temporary, contents, { mode })
  await rename(temporary, path)
}
