// The shared History: every Reviewer's filed Review Sessions, one schema v1
// file each (Sources/NitpickCore/SessionPersistence.swift's history log),
// readable by every Reviewer (PRD answer 2).
//
//   <data>/history/<session start>_<filer's login>.json
import { mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import {
  dateFromReference,
  decodeStoredHistoryEntry,
  encodeStoredHistoryEntry,
  type HistoryEntry,
} from "@nitpick/core"
import { writeAtomically } from "./reviewerStore.ts"

export class HistoryStore {
  readonly directory: string

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
