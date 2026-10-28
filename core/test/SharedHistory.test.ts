// Not a port: the Swift app's History had one Reviewer. These pin what a
// server holding every Reviewer's History adds (PRD answer 3, ADR-0014): who
// filed an entry is stored beside the schema v1 shape, a Swift file without
// it still round-trips byte for byte, and a Reviewer reads only their own.
import { describe, expect, test } from "vitest"
import {
  historyFiledBy,
  historyTrace,
  type HistoryEntry,
} from "../src/history.ts"
import {
  decodeStoredHistoryEntry,
  encodeStoredHistoryEntry,
} from "../src/storage.ts"
import {
  goldenInput,
  goldenText,
  historyEntryFrom,
  type DescribedHistoryEntry,
} from "./golden.ts"

const golden = historyEntryFrom(
  goldenInput<{ historyEntry: DescribedHistoryEntry }>(
    "stored-history-entry/history-entry.input.json"
  ).historyEntry
)
const vera = { login: "vera", fullName: "Vera Baumann" }
const noor = { login: "noor", fullName: "Noor Haddad" }

describe("Who filed a History entry", () => {
  test("is stored as filedBy, sorted among the v1 keys", () => {
    const json = encodeStoredHistoryEntry({ ...golden, filedBy: vera })

    expect(json).toBe(
      goldenText("stored-history-entry/history-entry.json").replace(
        ',"findings":',
        ',"filedBy":{"fullName":"Vera Baumann","login":"vera"},"findings":'
      )
    )
    expect(decodeStoredHistoryEntry(json)).toEqual({
      ...golden,
      filedBy: vera,
    })
  })

  test("is absent from a Swift History file, which re-encodes unchanged", () => {
    const json = goldenText("stored-history-entry/history-entry.json")
    const decoded = decodeStoredHistoryEntry(json)

    expect(decoded).not.toHaveProperty("filedBy")
    expect(encodeStoredHistoryEntry(decoded)).toBe(json)
  })

  test("a malformed filedBy names the field", () => {
    const json = encodeStoredHistoryEntry({ ...golden, filedBy: vera }).replace(
      '"login":"vera"',
      '"login":7'
    )

    expect(() => decodeStoredHistoryEntry(json)).toThrow(
      "filedBy.login is not a string"
    )
  })
})

describe("The Reviewer's own History", () => {
  const entry = (
    startedAt: number,
    filedBy: HistoryEntry["filedBy"]
  ): HistoryEntry => ({ ...golden, startedAt, filedBy })
  // Newest first, as the server lists it: Noor started last.
  const shared = [
    entry(300, noor),
    entry(200, vera),
    entry(150, undefined),
    entry(100, vera),
  ]

  test("keeps only the entries the Reviewer filed, newest first", () => {
    expect(historyFiledBy(shared, vera).map((e) => e.startedAt)).toEqual([
      200, 100,
    ])
  })

  test("the trace is the Reviewer's last session, not History's newest", () => {
    expect(historyTrace(historyFiledBy(shared, vera))?.latestEntry).toBe(
      shared[1]
    )
  })

  test("entries without a filer belong to nobody", () => {
    expect(historyFiledBy([entry(150, undefined)], vera)).toEqual([])
  })
})
