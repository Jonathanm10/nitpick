// One Reviewer's files under the server's data directory: the open Review
// Session as schema v1 JSON (Sources/NitpickCore/SessionPersistence.swift's
// manifest) with its captures and Design Snapshots beside it, the Recent
// devices, and the extracted Builds.
//
//   <reviewer>/open-session/session.json
//   <reviewer>/open-session/captures/<item id>.png
//   <reviewer>/open-session/design-snapshots/<item id>/<data version>.<ext>
//   <reviewer>/open-session/filing             while a File all runs
//   <reviewer>/recent-devices.json
//   <reviewer>/builds/<id>/…          one extracted upload each
//   <reviewer>/uploads/<id>.zip       an upload until it is extracted
//   <reviewer>/imports/<id>/…         a History import's zips while read
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  decodeStoredSession,
  designSnapshotFileExtension,
  encodeStoredSession,
  newUUID,
  RecentDevices,
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
   * Removes the whole slot, captures included.
   */
  async clearOpenSession(): Promise<void> {
    await rm(join(this.directory, "open-session"), {
      recursive: true,
      force: true,
    })
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

  /** A new, empty directory for one upload's Build, and where its zip lands. */
  async newBuildSlot(): Promise<{
    readonly id: string
    readonly archivePath: string
    readonly buildDirectory: string
  }> {
    const id = newUUID()
    const buildDirectory = join(this.#buildsDirectory, id)
    await mkdir(buildDirectory, { recursive: true })
    await mkdir(this.#uploadsDirectory, { recursive: true })
    return {
      id,
      archivePath: join(this.#uploadsDirectory, `${id}.zip`),
      buildDirectory,
    }
  }

  /** A directory for one History import's zips; it isn't created yet. */
  newImportDirectory(): string {
    return join(this.directory, "imports", newUUID())
  }

  /** Deletes every extracted Build except the one `keep` names. */
  async pruneBuilds(keep: string): Promise<void> {
    const ids = await readdir(this.#buildsDirectory).catch(() => [])
    await Promise.all(
      ids
        .filter((id) => id !== keep)
        .map((id) =>
          rm(join(this.#buildsDirectory, id), { recursive: true, force: true })
        )
    )
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

  get #buildsDirectory(): string {
    return join(this.directory, "builds")
  }

  get #uploadsDirectory(): string {
    return join(this.directory, "uploads")
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
