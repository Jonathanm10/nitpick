// The Build Library (ADR-0016): every Build uploaded to the Device Host, which
// every signed-in Reviewer sees and starts a review on, until one of them
// deletes it. It alone owns the library folder:
//
//   library/<id>/entry.json   the entry, written last
//   library/<id>/upload       the uploaded zip or .apk while it is read
//   library/<id>/build/…      the extracted zip, or the .apk
//
// A folder without entry.json is an upload that never finished, which the
// first operation after a start removes. A Build is in use while an open
// Review Session's Build lies in its folder or a start on it is under way,
// and deleting it is refused then.
import { createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream } from "node:stream/web"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  buildPlatform,
  newUUID,
  parseUUID,
  type Build,
  type BuildIdentity,
} from "@nitpick/core"
import {
  apkPath,
  appBundlePath,
  buildName,
  buildUploadName,
  readBuildFromArchive,
} from "./buildIngestion.ts"
import type { DeviceHost } from "./device/DeviceHost.ts"
import {
  readIfPresent,
  writeAtomically,
  type OpenSessionBuilds,
} from "./reviewerStore.ts"
import type { SubprocessRunner } from "./subprocess.ts"

/** Who uploaded a Build. */
export interface Uploader {
  readonly login: string
  readonly name: string
}

export interface LibraryEntry {
  readonly id: string
  /** The .app's name without `.app`, or the .apk's without `.apk`. */
  readonly name: string
  readonly build: Build
  readonly uploadedBy: Uploader
  /** ISO-8601. */
  readonly uploadedAt: string
}

/** The Build was never in the Library, or has been deleted from it. */
export class LibraryBuildNotFound extends Error {
  constructor() {
    super("That Build is no longer in the Build Library.")
    this.name = "LibraryBuildNotFound"
  }
}

/** A review is open or starting on the Build. */
export class LibraryBuildInUse extends Error {
  constructor() {
    super(
      "This Build is in a review, so it can't be deleted. Try again once that review ends."
    )
    this.name = "LibraryBuildInUse"
  }
}

/** An open session couldn't be read, so it may run the Build. */
export class LibraryUsageUnknown extends Error {
  constructor() {
    super(
      "A review on the Device Host can't be read, so this Build may be in it and can't be deleted. Ask whoever runs the Device Host to look at server.log."
    )
    this.name = "LibraryUsageUnknown"
  }
}

/** A start's hold on its Build: deleting the Build is refused until release. */
export interface LibraryLease {
  readonly build: Build
  release(): void
}

/** entry.json: no absolute path, so the folder can move. */
interface StoredEntry {
  readonly schema: 1
  readonly id: string
  readonly name: string
  readonly identity: BuildIdentity
  /** The .app or .apk, relative to the entry's folder. */
  readonly bundle: string
  readonly uploadedBy: Uploader
  readonly uploadedAt: string
}

const entryFile = "entry.json"

export class BuildLibrary {
  readonly #directory: string
  readonly #runner: SubprocessRunner
  readonly #deviceHost: Pick<DeviceHost, "readAndroidBuild">
  readonly #openSessionBuilds: () => Promise<OpenSessionBuilds>
  readonly #now: () => Date
  /** One id per start under way; two starts on one Build hold it twice. */
  readonly #leases: string[] = []
  /** Delete and a start's check that its Build exists run one at a time. */
  #lock: Promise<unknown> = Promise.resolve()
  #swept: Promise<void> | undefined

  constructor(
    directory: string,
    options: {
      /** Extracts uploaded zips. */
      readonly runner: SubprocessRunner
      /** Reads an uploaded .apk. */
      readonly deviceHost: Pick<DeviceHost, "readAndroidBuild">
      /** The Build of every Reviewer's open Review Session. */
      readonly openSessionBuilds: () => Promise<OpenSessionBuilds>
      readonly now?: () => Date
    }
  ) {
    this.#directory = resolve(directory)
    this.#runner = options.runner
    this.#deviceHost = options.deviceHost
    this.#openSessionBuilds = options.openSessionBuilds
    this.#now = options.now ?? (() => new Date())
  }

  /** Every Build in the Library, newest upload first. */
  async list(): Promise<
    ReadonlyArray<LibraryEntry & { readonly inUse: boolean }>
  > {
    await this.#prepared()
    const [names, usage] = await Promise.all([
      readdir(this.#directory).catch(() => []),
      this.#usage(),
    ])
    // An entry that can't be read leaves the list, and the rest stay in it.
    const entries = await Promise.all(
      names.map((name) =>
        this.get(name).catch((error: unknown) => {
          console.error(`The Build Library's ${name} can't be read.`, error)
          return undefined
        })
      )
    )
    return entries
      .filter((entry) => entry !== undefined)
      .sort((lhs, rhs) => (lhs.uploadedAt < rhs.uploadedAt ? 1 : -1))
      .map((entry) => ({
        ...entry,
        inUse: !usage.complete || usage.ids.has(entry.id),
      }))
  }

  /** The entry with this id, if the Library holds it. */
  async get(id: string): Promise<LibraryEntry | undefined> {
    await this.#prepared()
    const uuid = parseUUID(id)
    if (uuid === undefined) return undefined
    const folder = join(this.#directory, uuid)
    const json = await readIfPresent(join(folder, entryFile))
    return json === undefined ? undefined : decodeEntry(json, uuid, folder)
  }

  /**
   * Reads an uploaded zip or .apk into a new entry. A refused upload throws
   * before its bytes are read, or once they are, and leaves no files behind.
   */
  async add(
    upload: ReadableStream<Uint8Array> | null,
    fileName: string,
    uploader: Uploader
  ): Promise<LibraryEntry> {
    const uploaded = buildUploadName(fileName)
    await this.#prepared()
    const id = newUUID()
    const folder = join(this.#directory, id)
    const contents = join(folder, "build")
    const archivePath = join(folder, "upload")
    await mkdir(contents, { recursive: true })
    try {
      await pipeline(
        upload === null ? Readable.from([]) : Readable.fromWeb(upload),
        createWriteStream(archivePath)
      )
      const build =
        uploaded.kind === "apk"
          ? await this.#readAPK(
              archivePath,
              join(contents, `${uploaded.stem}.apk`),
              uploaded.name
            )
          : await readBuildFromArchive(
              this.#runner,
              { path: archivePath, name: uploaded.name },
              contents
            )
      await rm(archivePath, { force: true })
      const stored: StoredEntry = {
        schema: 1,
        id,
        name: buildName(build),
        identity: build.identity,
        bundle: relative(folder, bundlePath(build)),
        uploadedBy: uploader,
        uploadedAt: this.#now().toISOString(),
      }
      await writeAtomically(
        join(folder, entryFile),
        JSON.stringify(stored, null, 2)
      )
      return libraryEntry(stored, folder)
    } catch (error) {
      await rm(folder, { recursive: true, force: true })
      throw error
    }
  }

  /**
   * Deletes a Build no review is open or starting on, which needs every
   * open session read.
   */
  async delete(id: string): Promise<void> {
    await this.#locked(async () => {
      const entry = await this.get(id)
      if (entry === undefined) throw new LibraryBuildNotFound()
      const usage = await this.#usage()
      if (usage.ids.has(entry.id)) throw new LibraryBuildInUse()
      if (!usage.complete) throw new LibraryUsageUnknown()
      const folder = join(this.#directory, entry.id)
      // Its entry.json goes first, so a crash midway leaves a folder the
      // next start sweeps.
      await rm(join(folder, entryFile))
      await rm(folder, { recursive: true, force: true })
    })
  }

  /**
   * Runs `action` on the entry while no delete runs, so the entry is still
   * there when it ends; LibraryBuildNotFound once it is gone.
   */
  withEntry<T>(
    id: string,
    action: (entry: LibraryEntry) => T | Promise<T>
  ): Promise<T> {
    return this.#locked(async () => {
      const entry = await this.get(id)
      if (entry === undefined) throw new LibraryBuildNotFound()
      return action(entry)
    })
  }

  /**
   * The entry's Build for a start, which holds it in use from this check
   * until the start releases it, once its session is saved or it failed.
   */
  lease(id: string): Promise<LibraryLease> {
    return this.withEntry(id, (entry) => {
      this.#leases.push(entry.id)
      return {
        build: entry.build,
        release: () => {
          this.#leases.splice(this.#leases.indexOf(entry.id), 1)
        },
      }
    })
  }

  /**
   * The id of the entry `build` lies in; undefined outside the Library. A
   * path outside the Library's folder, as a session saved before the data
   * moved to another home has, names its entry by its last `library/<id>/`.
   */
  entryID(build: Build): string | undefined {
    const path = fileURLToPath(build.appBundleURL)
    const inside = relative(this.#directory, path).split(sep)
    if (inside[0] !== "..") {
      return inside.length > 1 && parseUUID(inside[0]!) === inside[0]
        ? inside[0]
        : undefined
    }
    const segments = path.split(sep)
    const folder = basename(this.#directory)
    for (let index = segments.length - 3; index >= 0; index--) {
      const id = segments[index + 1]!
      if (segments[index] === folder && parseUUID(id) === id) return id
    }
    return undefined
  }

  /**
   * The entries in use, and whether that is all of them: when an open
   * session couldn't be read, any entry may be its Build.
   */
  async #usage(): Promise<{
    readonly ids: ReadonlySet<string>
    readonly complete: boolean
  }> {
    // The leases before the sessions: a start saves its session before it
    // lets go of its lease, so one that ends while the sessions are read
    // shows in one or the other.
    const leased = [...this.#leases]
    const sessions = await this.#openSessionBuilds()
    return {
      ids: new Set([
        ...leased,
        ...sessions.builds
          .map((build) => this.entryID(build))
          .filter((id) => id !== undefined),
      ]),
      complete: sessions.complete,
    }
  }

  async #readAPK(
    archivePath: string,
    path: string,
    name: string
  ): Promise<Build> {
    await rename(archivePath, path)
    return this.#deviceHost.readAndroidBuild({ path, name })
  }

  #locked<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#lock.then(action)
    this.#lock = result.catch(() => {})
    return result
  }

  /** The sweep, once per server start, before anything else touches a folder. */
  #prepared(): Promise<void> {
    this.#swept ??= this.#sweep().catch((error: unknown) => {
      this.#swept = undefined
      throw error
    })
    return this.#swept
  }

  async #sweep(): Promise<void> {
    const children = await readdir(this.#directory, {
      withFileTypes: true,
    }).catch(() => [])
    await Promise.all(
      children
        .filter((child) => child.isDirectory())
        .map(async (child) => {
          const folder = join(this.#directory, child.name)
          try {
            if ((await readIfPresent(join(folder, entryFile))) !== undefined) {
              return
            }
          } catch (error) {
            // Not an unfinished upload: it stays for someone to look at.
            console.error(
              `The Build Library's ${child.name} can't be read.`,
              error
            )
            return
          }
          await rm(folder, { recursive: true, force: true })
        })
    )
  }
}

function bundlePath(build: Build): string {
  return buildPlatform(build) === "android"
    ? apkPath(build)
    : appBundlePath(build)
}

function libraryEntry(stored: StoredEntry, folder: string): LibraryEntry {
  const url = pathToFileURL(join(folder, stored.bundle)).href
  return {
    id: stored.id,
    name: stored.name,
    build: {
      identity: stored.identity,
      appBundleURL: stored.bundle.endsWith(".apk") ? url : `${url}/`,
    },
    uploadedBy: stored.uploadedBy,
    uploadedAt: stored.uploadedAt,
  }
}

/**
 * A schema 1 entry of this folder, uploaded at a date, whose bundle lies
 * inside it, or undefined.
 */
function decodeEntry(
  json: string,
  id: string,
  folder: string
): LibraryEntry | undefined {
  let stored: Partial<StoredEntry> | null
  try {
    stored = JSON.parse(json) as Partial<StoredEntry> | null
  } catch {
    return undefined
  }
  const { identity, uploadedBy } = stored ?? {}
  const strings = [
    stored?.name,
    stored?.bundle,
    stored?.uploadedAt,
    identity?.bundleID,
    identity?.version,
    identity?.buildNumber,
    uploadedBy?.login,
    uploadedBy?.name,
  ]
  if (
    stored?.schema !== 1 ||
    stored.id !== id ||
    !strings.every((value) => typeof value === "string")
  ) {
    return undefined
  }
  const entry = stored as StoredEntry
  return !Number.isNaN(Date.parse(entry.uploadedAt)) &&
    !isAbsolute(entry.bundle) &&
    resolve(folder, entry.bundle).startsWith(folder + sep)
    ? libraryEntry(entry, folder)
    : undefined
}
