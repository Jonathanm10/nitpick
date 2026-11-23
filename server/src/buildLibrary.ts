// The Build Library (ADR-0016): every Build uploaded to the Device Host, which
// every signed-in Reviewer sees and starts a review on. It alone owns the
// library folder:
//
//   library/<id>/entry.json   the entry, written last
//   library/<id>/upload       the uploaded zip or .apk while it is read
//   library/<id>/build/…      the extracted zip, or the .apk
//
// A folder without entry.json is an upload that never finished, which the
// first operation after a start removes.
import { createWriteStream } from "node:fs"
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
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
import { readIfPresent, writeAtomically } from "./reviewerStore.ts"
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
  readonly #now: () => Date
  #swept: Promise<void> | undefined

  constructor(
    directory: string,
    options: {
      /** Extracts uploaded zips. */
      readonly runner: SubprocessRunner
      /** Reads an uploaded .apk. */
      readonly deviceHost: Pick<DeviceHost, "readAndroidBuild">
      readonly now?: () => Date
    }
  ) {
    this.#directory = resolve(directory)
    this.#runner = options.runner
    this.#deviceHost = options.deviceHost
    this.#now = options.now ?? (() => new Date())
  }

  /** Every Build in the Library, newest upload first. */
  async list(): Promise<ReadonlyArray<LibraryEntry>> {
    await this.#prepared()
    const names = await readdir(this.#directory).catch(() => [])
    const entries = await Promise.all(names.map((name) => this.get(name)))
    return entries
      .filter((entry) => entry !== undefined)
      .sort((lhs, rhs) => (lhs.uploadedAt < rhs.uploadedAt ? 1 : -1))
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

  /** The id of the entry `build` lies in; undefined outside the Library. */
  entryID(build: Build): string | undefined {
    const [id, ...rest] = relative(
      this.#directory,
      fileURLToPath(build.appBundleURL)
    ).split(sep)
    return id !== undefined && parseUUID(id) === id && rest.length > 0
      ? id
      : undefined
  }

  async #readAPK(
    archivePath: string,
    path: string,
    name: string
  ): Promise<Build> {
    await rename(archivePath, path)
    return this.#deviceHost.readAndroidBuild({ path, name })
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
          if ((await readIfPresent(join(folder, entryFile))) === undefined) {
            await rm(folder, { recursive: true, force: true })
          }
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

/** A schema 1 entry of this folder whose bundle lies inside it, or undefined. */
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
  return resolve(folder, entry.bundle).startsWith(folder + sep)
    ? libraryEntry(entry, folder)
    : undefined
}
