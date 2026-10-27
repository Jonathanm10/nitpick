// Stands in for the server's storage the way the Swift suite's temporary
// workspace did: the open session and History are kept as the v1 JSON the
// codec writes, so a "relaunch" decodes exactly what the last save wrote.
import type { DesignSnapshot } from "../src/designSnapshot.ts"
import type { HistoryEntry } from "../src/history.ts"
import type { FilingStore } from "../src/issueFiling.ts"
import type { ReviewSession } from "../src/reviewSession.ts"
import {
  decodeStoredHistoryEntry,
  decodeStoredSession,
  encodeStoredHistoryEntry,
  encodeStoredSession,
} from "../src/storage.ts"

export class SaveRefused extends Error {
  constructor() {
    super("The open session could not be saved.")
    this.name = "SaveRefused"
  }
}

export class FakeFilingStore implements FilingStore {
  /** The bytes behind each tray item's capture; others get `defaultCapture`. */
  readonly captures = new Map<string, Uint8Array>()
  /** Design Snapshot bytes, by `dataVersion`. */
  readonly designSnapshots = new Map<string, Uint8Array>()
  /** While set, a save throws, like a workspace that became unwritable. */
  refusesSaves = false
  readonly #defaultCapture: Uint8Array
  readonly #events: string[] | undefined
  #openSession: string | undefined
  readonly #history = new Map<number, string>()

  /** `events`, when given, gets a line per save and History record. */
  constructor(defaultCapture: Uint8Array, events?: string[]) {
    this.#defaultCapture = defaultCapture
    this.#events = events
  }

  async saveOpenSession(session: ReviewSession): Promise<void> {
    if (this.refusesSaves) throw new SaveRefused()
    this.#openSession = encodeStoredSession(session)
    this.#events?.push(`save ${filingStates(session)}`)
  }

  async recordInHistory(entry: HistoryEntry): Promise<void> {
    this.#history.set(entry.startedAt, encodeStoredHistoryEntry(entry))
    this.#openSession = undefined
    this.#events?.push("history")
  }

  async capturePNG(itemID: string): Promise<Uint8Array> {
    return this.captures.get(itemID) ?? this.#defaultCapture
  }

  async designSnapshotData(
    _itemID: string,
    snapshot: DesignSnapshot
  ): Promise<Uint8Array> {
    const data = this.designSnapshots.get(snapshot.dataVersion)
    if (data === undefined) throw new Error(`no bytes for ${snapshot.name}`)
    return data
  }

  /** The open slot as a relaunch reads it back. */
  loadOpenSession(): ReviewSession | undefined {
    return this.#openSession === undefined
      ? undefined
      : decodeStoredSession(this.#openSession)
  }

  /** The stored manifest's exact bytes. */
  get openSessionJSON(): string | undefined {
    return this.#openSession
  }

  /** Every recorded entry, newest first. */
  sessionHistory(): HistoryEntry[] {
    return [...this.#history.values()]
      .map(decodeStoredHistoryEntry)
      .sort((a, b) => b.startedAt - a.startedAt)
  }
}

function filingStates(session: ReviewSession): string {
  return session.tray.map((item) => item.filingProgress.state).join(",")
}
