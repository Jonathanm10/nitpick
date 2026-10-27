// Uploaded Build intake, ported from Sources/NitpickCore/BuildIngestion.swift
// and the errors of Sources/NitpickCore/Build.swift. A browser uploads files,
// not bundles, so only a zip is accepted: the server extracts it, finds the
// first .app breadth-first and reads the Build's identity from its Info.plist.
import type { Dirent } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Build } from "@nitpick/core"
import { parse, type PlistValue } from "plist"
import {
  SubprocessFailure,
  type SubprocessCommand,
  type SubprocessRunner,
} from "./subprocess.ts"

/** Why an upload could not become a Build: Swift's BuildIngestError cases. */
export type BuildIngestFailure =
  /** The uploaded file is not a zip. */
  | { readonly kind: "unsupportedFileType"; readonly fileName: string }
  | { readonly kind: "noAppBundleInArchive"; readonly archiveName: string }
  | { readonly kind: "missingInfoPlist"; readonly bundleName: string }
  | { readonly kind: "malformedInfoPlist"; readonly bundleName: string }
  | {
      readonly kind: "missingIdentityKeys"
      readonly bundleName: string
      readonly keys: ReadonlyArray<string>
    }
  | {
      readonly kind: "notASimulatorBuild"
      readonly bundleName: string
      readonly platforms: ReadonlyArray<string>
    }

export class BuildIngestError extends Error {
  readonly failure: BuildIngestFailure

  constructor(failure: BuildIngestFailure) {
    super(message(failure))
    this.name = "BuildIngestError"
    this.failure = failure
  }
}

function message(failure: BuildIngestFailure): string {
  switch (failure.kind) {
    case "unsupportedFileType":
      return `“${failure.fileName}” is not a Build. Drop or choose a zip containing a simulator .app.`
    case "noAppBundleInArchive":
      return `“${failure.archiveName}” contains no .app bundle.`
    case "missingInfoPlist":
      return `“${failure.bundleName}” has no Info.plist, so its identity can't be read. Is it a complete .app bundle?`
    case "malformedInfoPlist":
      return `The Info.plist in “${failure.bundleName}” can't be read.`
    case "missingIdentityKeys":
      return `The Info.plist in “${failure.bundleName}” is missing ${failure.keys.join(", ")}.`
    case "notASimulatorBuild": {
      const built =
        failure.platforms.length === 0
          ? "an unknown platform"
          : failure.platforms.join(", ")
      return `“${failure.bundleName}” is built for ${built}, not the iOS simulator. Ask for a simulator Build from CI.`
    }
  }
}

/**
 * The uploaded file's name when it names a zip, so the upload is refused
 * before its bytes are read. Like Foundation's pathExtension, a name that is
 * only dots before the extension (".zip", "..zip") has no extension.
 */
export function zipArchiveName(fileName: string): string {
  const name = basename(fileName)
  const dot = name.lastIndexOf(".")
  const stem = name.slice(0, dot)
  const isZip =
    dot > 0 &&
    !/^\.+$/.test(stem) &&
    name.slice(dot + 1).toLowerCase() === "zip"
  if (!isZip) {
    throw new BuildIngestError({ kind: "unsupportedFileType", fileName: name })
  }
  return name
}

/**
 * Extracts the zip at `archivePath` into `destination`, which must be a new,
 * empty directory, and reads the .app inside.
 */
export async function readBuildFromArchive(
  runner: SubprocessRunner,
  archive: { readonly path: string; readonly name: string },
  destination: string
): Promise<Build> {
  // bsdtar, not ditto: an uploaded zip is a trust boundary, and bsdtar's
  // defaults enforce containment where ditto enforces nothing. Entries with
  // ".." fail the extraction, a leading "/" is stripped, and writing through
  // a symlink is refused (libarchive SECURE_NODOTDOT / SECURE_SYMLINKS).
  const extract: SubprocessCommand = {
    executablePath: "/usr/bin/tar",
    arguments: ["-x", "-f", archive.path, "-C", destination],
  }
  const result = await runner.run(extract)
  if (result.exitCode !== 0) {
    throw new SubprocessFailure(
      extract,
      result.exitCode,
      result.standardError.toString("utf8")
    )
  }
  const appBundle = await firstAppBundle(destination)
  if (appBundle === undefined) {
    throw new BuildIngestError({
      kind: "noAppBundleInArchive",
      archiveName: archive.name,
    })
  }
  return readAppBundle(appBundle)
}

/**
 * Breadth-first and name-sorted, so the bundle found doesn't depend on the
 * filesystem's order. Hidden entries are skipped, and the search never
 * descends into a .app.
 */
async function firstAppBundle(root: string): Promise<string | undefined> {
  const queue = [root]
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index]
    const children: Dirent[] = await readdir(directory, {
      withFileTypes: true,
    }).catch(() => [])
    const sorted = children
      .filter((child) => !child.name.startsWith("."))
      .sort((lhs, rhs) => compareStrings(lhs.name, rhs.name))
    for (const child of sorted) {
      // Only real directories: a crafted archive can deliver `Whatever.app`
      // as a symlink pointing outside the extraction root, which must never
      // be ingested. A Dirent describes the link itself, never its target.
      if (!child.isDirectory()) continue
      const path = join(directory, child.name)
      if (child.name.endsWith(".app")) return path
      queue.push(path)
    }
  }
  return undefined
}

const identityKeys = [
  "CFBundleIdentifier",
  "CFBundleShortVersionString",
  "CFBundleVersion",
] as const

/** Reads a Build's identity from `<bundle>/Info.plist`. */
export async function readAppBundle(bundlePath: string): Promise<Build> {
  const bundleName = basename(bundlePath)
  let data: Buffer
  try {
    data = await readFile(join(bundlePath, "Info.plist"))
  } catch {
    throw new BuildIngestError({ kind: "missingInfoPlist", bundleName })
  }
  const info = parseDictionary(data)
  if (info === undefined) {
    throw new BuildIngestError({ kind: "malformedInfoPlist", bundleName })
  }

  const values = identityKeys.map((key) => {
    const value = info[key]
    return typeof value === "string" && value !== "" ? value : undefined
  })
  const missing = identityKeys.filter((_, index) => values[index] === undefined)
  const [bundleID, version, buildNumber] = values
  if (
    bundleID === undefined ||
    version === undefined ||
    buildNumber === undefined
  ) {
    throw new BuildIngestError({
      kind: "missingIdentityKeys",
      bundleName,
      keys: missing,
    })
  }

  // Like Swift's `as? [String]`: one non-string element voids the list.
  const declared = info.CFBundleSupportedPlatforms
  const platforms =
    Array.isArray(declared) &&
    declared.every((platform) => typeof platform === "string")
      ? declared
      : []
  if (!platforms.includes("iPhoneSimulator")) {
    throw new BuildIngestError({
      kind: "notASimulatorBuild",
      bundleName,
      platforms,
    })
  }

  return {
    identity: { bundleID, version, buildNumber },
    appBundleURL: `${pathToFileURL(bundlePath).href}/`,
  }
}

/** A binary or XML property list whose root is a dictionary. */
function parseDictionary(
  data: Buffer
): { readonly [key: string]: PlistValue } | undefined {
  let root: PlistValue
  try {
    // Given bytes, the parser reads only the binary format; XML and OpenStep
    // are read from text.
    root =
      data.subarray(0, 6).toString("latin1") === "bplist"
        ? parse(new Uint8Array(data))
        : parse(data.toString("utf8"))
  } catch {
    return undefined
  }
  return isDictionary(root) ? root : undefined
}

function isDictionary(
  value: PlistValue
): value is { readonly [key: string]: PlistValue } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  )
}

/** The .app on disk, without the URL's trailing slash, as Swift's `path`. */
export function appBundlePath(build: Build): string {
  return fileURLToPath(build.appBundleURL).slice(0, -1)
}

/** The name the page shows for a Build: its .app's name without `.app`. */
export function buildName(build: Build): string {
  return basename(appBundlePath(build)).replace(/\.app$/, "")
}

/** Not locale-aware, like the Swift app's `<` on names. */
function compareStrings(lhs: string, rhs: string): number {
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0
}
