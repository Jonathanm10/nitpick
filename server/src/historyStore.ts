// The shared History: every Reviewer's filed Review Sessions, one schema v1
// file each (Sources/NitpickCore/SessionPersistence.swift's history log),
// readable by every Reviewer (PRD answer 2).
//
//   <data>/history/<session start>_<filer's login>.json
import { link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  dateFromReference,
  decodeStoredHistoryEntry,
  encodeStoredHistoryEntry,
  newUUID,
  type HistoryEntry,
} from "@nitpick/core"
import { writeAtomically } from "./reviewerStore.ts"

/**
 * What became of one imported entry. `nameTaken`: History holds another
 * session by the same filer that started in the same millisecond, which the
 * import never writes over.
 */
export type HistoryImportOutcome = "imported" | "duplicate" | "nameTaken"

export class HistoryStore {
  readonly directory: string
  /** Imports run one at a time, so two at once can't both add an entry. */
  #imports: Promise<unknown> = Promise.resolve()

  constructor(directory: string) {
    this.directory = directory
  }

  /**
   * Every entry, newest session first, as Swift's sessionHistory listed
   * them. A file this schema can't read fails the whole read, as there.
   */
  async entries(): Promise<HistoryEntry[]> {
    await mkdir(this.directory, { recursive: true })
    const names = (await readdir(this.directory))
      .filter((name) => name.endsWith(".json"))
      .sort()
    const entries = await Promise.all(
      names.map(async (name) =>
        decodeStoredHistoryEntry(
          await readFile(join(this.directory, name), "utf8")
        )
      )
    )
    return entries.sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Writes a filed session's entry. Recording the same session again, as a
   * resumed File all may, replaces it: the file is named by the session's
   * start and its filer, a Review Session's identity in a shared History.
   */
  async record(entry: HistoryEntry): Promise<void> {
    await writeAtomically(
      join(this.directory, historyFileName(entry)),
      encodeStoredHistoryEntry(entry)
    )
  }

  /**
   * Adds entries brought from elsewhere, the Swift app's own History, in
   * order. An entry with the same session start and the same Issue IDs as
   * one History holds, or one added earlier in the same import, is skipped,
   * so importing a set again adds nothing.
   */
  import(
    entries: ReadonlyArray<HistoryEntry>
  ): Promise<HistoryImportOutcome[]> {
    const result = this.#imports.then(async () => {
      const held = new Set((await this.entries()).map(sessionIdentity))
      const outcomes: HistoryImportOutcome[] = []
      for (const entry of entries) {
        const identity = sessionIdentity(entry)
        if (held.has(identity)) {
          outcomes.push("duplicate")
          continue
        }
        const written = await writeNew(
          join(this.directory, historyFileName(entry)),
          encodeStoredHistoryEntry(entry)
        )
        if (written) held.add(identity)
        outcomes.push(written ? "imported" : "nameTaken")
      }
      return outcomes
    })
    this.#imports = result.catch(() => {})
    return result
  }
}

/**
 * A filed session as import tells it apart: when it started, to Swift's
 * exact double, and which Issues it filed, in any order.
 */
function sessionIdentity(entry: HistoryEntry): string {
  const issues = entry.findings.map((finding) => finding.issue.idReadable)
  return JSON.stringify([entry.startedAt, issues.sort()])
}

/**
 * Writes `contents` aside and hard-links it into place, so a file already
 * at `path` is never replaced. False when one is.
 */
async function writeNew(path: string, contents: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${newUUID()}.tmp`
  await writeFile(temporary, contents)
  try {
    await link(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * Swift's name, the start moment with fractional seconds and colons swapped
 * out, plus the filer's login, so two Reviewers starting in the same
 * millisecond never share a file.
 */
function historyFileName(entry: HistoryEntry): string {
  const start = dateFromReference(entry.startedAt)
    .toISOString()
    .replaceAll(":", "-")
  return entry.filedBy === undefined
    ? `${start}.json`
    : `${start}_${encodeURIComponent(entry.filedBy.login)}.json`
}
