// One Reviewer's files under the server's data directory: the open Review
// Session as schema v1 JSON (Sources/NitpickCore/SessionPersistence.swift's
// manifest), the Recent devices, and the extracted Builds.
//
//   <reviewer>/open-session/session.json
//   <reviewer>/recent-devices.json
//   <reviewer>/builds/<id>/…          one extracted upload each
//   <reviewer>/uploads/<id>.zip       an upload until it is extracted
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
  encodeStoredSession,
  newUUID,
  RecentDevices,
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

  async saveOpenSession(session: ReviewSession): Promise<void> {
    await writeAtomically(
      this.#openSessionManifest,
      encodeStoredSession(session)
    )
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

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** A crash mid-write keeps the previous good file. */
async function writeAtomically(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${newUUID()}.tmp`
  await writeFile(temporary, contents)
  await rename(temporary, path)
}
