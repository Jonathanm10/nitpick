// History import: the schema v1 files the Swift app wrote under
// `~/Library/Application Support/Nitpick/history`, or a zip of that folder,
// brought into the shared History. Each file is read with the v1 codec and
// refused alone, with today's message; the others still import. An imported
// entry belongs to the Reviewer who ran the import (PRD answer 3).
import type { Dirent } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import {
  decodeStoredHistoryEntry,
  decodeStoredSession,
  MalformedStoredData,
  type HistoryEntry,
  type YouTrackUser,
} from "@nitpick/core"
import type { HistoryImportResult } from "./api.ts"
import type { HistoryStore } from "./historyStore.ts"
import type { SubprocessRunner } from "./subprocess.ts"

/** One file the Reviewer chose: a History file, or a zip of the folder. */
export interface HistoryUpload {
  readonly name: string
  readonly bytes: Uint8Array
}

/** Far above any History file, which holds text and links only. */
const largestHistoryFile = 10 * 1024 * 1024

/**
 * Imports `uploads` in the order chosen, files inside a zip in name order,
 * and says what became of each History file. `scratchDirectory` is a new
 * directory that holds the zips while they're read; it's removed after.
 */
export async function importHistory(
  uploads: ReadonlyArray<HistoryUpload>,
  options: {
    readonly history: HistoryStore
    readonly runner: SubprocessRunner
    readonly scratchDirectory: string
    readonly importer: YouTrackUser
  }
): Promise<HistoryImportResult[]> {
  const { history, runner, scratchDirectory, importer } = options
  try {
    const files: Array<HistoryFile | HistoryImportResult> = []
    for (const [index, upload] of uploads.entries()) {
      const extension = extname(upload.name).toLowerCase()
      if (extension === ".json") {
        files.push({ file: upload.name, text: upload.bytes })
      } else if (extension === ".zip") {
        files.push(
          ...(await filesInZip(
            upload,
            join(scratchDirectory, String(index)),
            runner
          ))
        )
      } else {
        files.push({
          file: upload.name,
          outcome: "refused",
          error: `“${upload.name}” isn't a History file. Choose the .json files in the Swift app's history folder, or a zip of that folder.`,
        })
      }
    }
    const read = files.map((file) =>
      "outcome" in file ? file : readHistoryFile(file, importer)
    )
    const outcomes = await history.import(
      read.flatMap((file) => ("entry" in file ? [file.entry] : []))
    )
    let next = 0
    return read.map((file): HistoryImportResult => {
      if (!("entry" in file)) return file
      const outcome = outcomes[next++]
      return outcome === "nameTaken"
        ? {
            file: file.file,
            outcome: "refused",
            error:
              "History already holds another session you filed that started at the same moment.",
          }
        : { file: file.file, outcome }
    })
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true })
  }
}

/** A History file's name, as the page shows it, and its bytes. */
interface HistoryFile {
  readonly file: string
  readonly text: Uint8Array
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

function readHistoryFile(
  { file, text }: HistoryFile,
  importer: YouTrackUser
):
  | HistoryImportResult
  | { readonly file: string; readonly entry: HistoryEntry } {
  let json: string
  try {
    json = utf8.decode(text)
  } catch {
    return refused(file, new MalformedStoredData("it is not JSON"))
  }
  try {
    return {
      file,
      entry: { ...decodeStoredHistoryEntry(json), filedBy: importer },
    }
  } catch (error) {
    // The open session's manifest isn't History: it's filed or ended in the
    // Swift app first, which records it there.
    if (error instanceof MalformedStoredData && isOpenSession(json)) {
      return { file, outcome: "openSession" }
    }
    return refused(file, error)
  }
}

function isOpenSession(json: string): boolean {
  try {
    decodeStoredSession(json)
    return true
  } catch {
    return false
  }
}

function refused(file: string, error: unknown): HistoryImportResult {
  return {
    file,
    outcome: "refused",
    error: error instanceof Error ? error.message : String(error),
  }
}

/**
 * The .json files in a zip, named `<zip> › <path inside>`. bsdtar extracts
 * it, as it does an uploaded Build, so no entry lands outside `directory`;
 * macOS's `__MACOSX` metadata and hidden files are skipped, and a symlink is
 * never followed.
 */
async function filesInZip(
  upload: HistoryUpload,
  directory: string,
  runner: SubprocessRunner
): Promise<Array<HistoryFile | HistoryImportResult>> {
  const archive = `${directory}.zip`
  await mkdir(directory, { recursive: true })
  await writeFile(archive, upload.bytes)
  const result = await runner.run({
    executablePath: "/usr/bin/tar",
    arguments: ["-x", "--no-mac-metadata", "-f", archive, "-C", directory],
  })
  if (result.exitCode !== 0) {
    return [
      {
        file: upload.name,
        outcome: "refused",
        error: `“${upload.name}” can't be opened as a zip.`,
      },
    ]
  }
  const paths = await jsonFilesUnder(directory)
  if (paths.length === 0) {
    return [
      {
        file: upload.name,
        outcome: "refused",
        error: `“${upload.name}” holds no .json files. Zip the Swift app's history folder.`,
      },
    ]
  }
  return Promise.all(
    paths.map(async (path): Promise<HistoryFile | HistoryImportResult> => {
      const file = `${upload.name} › ${path}`
      const absolute = join(directory, path)
      if ((await stat(absolute)).size > largestHistoryFile) {
        return refused(
          file,
          new MalformedStoredData("it is too large to be a History file")
        )
      }
      return { file, text: await readFile(absolute) }
    })
  )
}

/** Relative paths of the regular .json files under `root`, sorted. */
async function jsonFilesUnder(root: string): Promise<string[]> {
  const found: string[] = []
  const queue = [""]
  for (let index = 0; index < queue.length; index++) {
    const directory = queue[index]
    const children: Dirent[] = await readdir(join(root, directory), {
      withFileTypes: true,
    })
    for (const child of children) {
      if (child.name.startsWith(".") || child.name === "__MACOSX") continue
      const path = directory === "" ? child.name : `${directory}/${child.name}`
      // A Dirent describes a symlink itself, never its target.
      if (child.isDirectory()) queue.push(path)
      else if (child.isFile() && extname(child.name).toLowerCase() === ".json")
        found.push(path)
    }
  }
  return found.sort()
}
